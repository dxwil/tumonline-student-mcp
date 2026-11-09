import { SafeError } from "./errors.js";

const MAX_XML = 2_000_000;

export function parseXml(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  if (text.length > MAX_XML) {
    throw new SafeError("response_too_large", "TUMonline returned a response that is too large to accept.");
  }
  if (/<!DOCTYPE/i.test(text)) {
    throw new SafeError("malformed", "TUMonline returned a document type that was not accepted.");
  }
  const source = text.replace(/<!--[\s\S]*?-->/g, "");
  const parser = new Parser(source);
  parser.skipProlog();
  const root = parser.parseElement();
  if (!root) {
    throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
  }
  return root;
}

export function child(node, name) {
  if (!node) {
    return null;
  }
  const wanted = localName(name);
  return (node.children ?? []).find((entry) => localName(entry.name) === wanted) ?? null;
}

export function childrenNamed(node, name) {
  if (!node) {
    return [];
  }
  const wanted = localName(name);
  return (node.children ?? []).filter((entry) => localName(entry.name) === wanted);
}

export function textOf(node, name) {
  const found = name ? child(node, name) : node;
  if (!found) {
    return null;
  }
  const text = found.text.trim();
  return text === "" ? null : text;
}

export function findFirst(node, name) {
  const wanted = localName(name);
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current) {
      continue;
    }
    if (localName(current.name) === wanted) {
      return current;
    }
    for (const entry of current.children ?? []) {
      stack.push(entry);
    }
  }
  return null;
}

export function findAll(node, name) {
  const wanted = localName(name);
  const found = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (localName(current.name) === wanted) {
      found.push(current);
    }
    for (const entry of current.children ?? []) {
      stack.push(entry);
    }
  }
  return found.reverse();
}

export function elementValue(node) {
  if (!node || node.attrs?.isnull === "true") {
    return null;
  }
  const elements = (node.children ?? []).filter((entry) => entry.attrs?.isnull !== "true");
  if (elements.length === 0) {
    return node.text.trim();
  }
  const value = {};
  for (const entry of elements) {
    const key = localName(entry.name);
    const childValue = elementValue(entry);
    if (value[key] === undefined) {
      value[key] = childValue;
    } else if (Array.isArray(value[key])) {
      value[key].push(childValue);
    } else {
      value[key] = [value[key], childValue];
    }
  }
  return value;
}

export function rows(root) {
  const rowset = findFirst(root, "rowset") ?? root;
  return childrenNamed(rowset, "row").map((row) => elementValue(row) ?? {});
}

export function errorMessage(root) {
  const err = root && localName(root.name) === "error" ? root : findFirst(root, "error");
  if (!err) {
    return null;
  }
  return textOf(err, "message") ?? (err.text.trim() || null);
}

function localName(name) {
  const text = String(name ?? "");
  const colon = text.lastIndexOf(":");
  return colon === -1 ? text : text.slice(colon + 1);
}

class Parser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  skipProlog() {
    this.skipSpace();
    while (this.source.startsWith("<?", this.index)) {
      const end = this.source.indexOf("?>", this.index);
      if (end < 0) {
        throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
      }
      this.index = end + 2;
      this.skipSpace();
    }
  }

  parseElement() {
    this.skipSpace();
    if (this.source[this.index] !== "<" || this.source[this.index + 1] === "/") {
      return null;
    }
    this.index += 1;
    const name = this.readName();
    const attrs = this.readAttrs();
    this.skipSpace();
    if (this.source.startsWith("/>", this.index)) {
      this.index += 2;
      return { name, attrs, children: [], text: "" };
    }
    if (this.source[this.index] !== ">") {
      throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
    }
    this.index += 1;
    const children = [];
    let text = "";
    while (this.index < this.source.length) {
      if (this.source.startsWith("</", this.index)) {
        this.index += 2;
        const endName = this.readName();
        this.skipSpace();
        if (this.source[this.index] !== ">" || localName(endName) !== localName(name)) {
          throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
        }
        this.index += 1;
        return { name, attrs, children, text };
      }
      if (this.source.startsWith("<![CDATA[", this.index)) {
        const end = this.source.indexOf("]]>", this.index + 9);
        if (end < 0) {
          throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
        }
        text += this.source.slice(this.index + 9, end);
        this.index = end + 3;
        continue;
      }
      if (this.source[this.index] === "<") {
        const child = this.parseElement();
        if (!child) {
          throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
        }
        children.push(child);
        continue;
      }
      const next = this.source.indexOf("<", this.index);
      const raw = this.source.slice(this.index, next === -1 ? this.source.length : next);
      text += decodeEntities(raw);
      this.index = next === -1 ? this.source.length : next;
    }
    throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
  }

  readName() {
    const match = /^[A-Za-z_:][\w:.-]*/.exec(this.source.slice(this.index));
    if (!match) {
      throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
    }
    this.index += match[0].length;
    return match[0];
  }

  readAttrs() {
    const attrs = {};
    while (this.index < this.source.length) {
      this.skipSpace();
      if (this.source[this.index] === ">" || this.source[this.index] === "/") {
        break;
      }
      const name = this.readName();
      this.skipSpace();
      if (this.source[this.index] !== "=") {
        throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
      }
      this.index += 1;
      this.skipSpace();
      const quote = this.source[this.index];
      if (quote !== '"' && quote !== "'") {
        throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
      }
      this.index += 1;
      const end = this.source.indexOf(quote, this.index);
      if (end < 0) {
        throw new SafeError("malformed", "TUMonline returned a response that is not XML.");
      }
      attrs[localName(name)] = decodeEntities(this.source.slice(this.index, end));
      this.index = end + 1;
    }
    return attrs;
  }

  skipSpace() {
    while (this.index < this.source.length && /\s/.test(this.source[this.index])) {
      this.index += 1;
    }
  }
}

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (whole, entity) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    if (entity[0] !== "#") return whole;
    const hex = entity[1] === "x" || entity[1] === "X";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
  });
}
