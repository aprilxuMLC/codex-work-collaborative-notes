const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const OL_RE = /^ {0,3}\d+[.)][ \t]+(.*)$/;

function inlineText(value) {
  let output = "";
  for (let index = 0; index < value.length;) {
    if (value.startsWith("**", index)) {
      const end = value.indexOf("**", index + 2);
      if (end >= index + 3) {
        output += inlineText(value.slice(index + 2, end));
        index = end + 2;
        continue;
      }
    }
    if (value[index] === "*") {
      const end = value.indexOf("*", index + 1);
      if (end >= index + 2) {
        output += inlineText(value.slice(index + 1, end));
        index = end + 1;
        continue;
      }
    }
    if (value[index] === "`") {
      const end = value.indexOf("`", index + 1);
      if (end >= index + 2) {
        output += value.slice(index + 1, end);
        index = end + 1;
        continue;
      }
    }
    if (value[index] === "[") {
      const close = value.indexOf("](", index + 1);
      const end = close < 0 ? -1 : value.indexOf(")", close + 2);
      if (close > index + 1 && end > close + 2) {
        output += inlineText(value.slice(index + 1, close));
        index = end + 1;
        continue;
      }
    }
    output += value[index];
    index += 1;
  }
  return output;
}

function blockText(lines) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1][0];
      const closing = new RegExp(`^ {0,3}${marker}{${fence[1].length},}[ \\t]*$`);
      index += 1;
      const code = [];
      while (index < lines.length && !closing.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      output.push(code.join("\n"));
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      output.push(inlineText(heading[2]));
      index += 1;
      continue;
    }
    const unordered = line.match(UL_RE);
    if (unordered) {
      output.push(inlineText(unordered[1]));
      index += 1;
      continue;
    }
    const ordered = line.match(OL_RE);
    if (ordered) {
      output.push(inlineText(ordered[1]));
      index += 1;
      continue;
    }
    output.push(inlineText(line));
    index += 1;
  }
  return output.join("\n");
}

export function projectMarkdown(value) {
  return blockText(String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n"));
}

export const visibleText = projectMarkdown;
export const renderText = projectMarkdown;
