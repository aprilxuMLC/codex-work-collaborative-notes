(function (global) {
  "use strict";

  const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
  const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
  const UL_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
  const OL_RE = /^ {0,3}\d+[.)][ \t]+(.*)$/;

  function inlineProjection(value) {
    let output = "";
    for (let index = 0; index < value.length;) {
      if (value.startsWith("**", index)) {
        const end = value.indexOf("**", index + 2);
        if (end >= index + 3) { output += inlineProjection(value.slice(index + 2, end)); index = end + 2; continue; }
      }
      if (value[index] === "*") {
        const end = value.indexOf("*", index + 1);
        if (end >= index + 2) { output += inlineProjection(value.slice(index + 1, end)); index = end + 1; continue; }
      }
      if (value[index] === "`") {
        const end = value.indexOf("`", index + 1);
        if (end >= index + 2) { output += value.slice(index + 1, end); index = end + 1; continue; }
      }
      if (value[index] === "[") {
        const close = value.indexOf("](", index + 1);
        const end = close < 0 ? -1 : value.indexOf(")", close + 2);
        if (close > index + 1 && end > close + 2) { output += inlineProjection(value.slice(index + 1, close)); index = end + 1; continue; }
      }
      output += value[index++];
    }
    return output;
  }

  function projectMarkdown(value) {
    const lines = String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    const output = [];
    for (let index = 0; index < lines.length;) {
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
      const unordered = line.match(UL_RE);
      const ordered = line.match(OL_RE);
      output.push(inlineProjection(heading ? heading[2] : unordered ? unordered[1] : ordered ? ordered[1] : line));
      index += 1;
    }
    return output.join("\n");
  }

  function appendInline(parent, value) {
    for (let index = 0; index < value.length;) {
      if (value.startsWith("**", index)) {
        const end = value.indexOf("**", index + 2);
        if (end >= index + 3) {
          const strong = document.createElement("strong");
          appendInline(strong, value.slice(index + 2, end));
          parent.append(strong);
          index = end + 2;
          continue;
        }
      }
      if (value[index] === "*") {
        const end = value.indexOf("*", index + 1);
        if (end >= index + 2) {
          const emphasis = document.createElement("em");
          appendInline(emphasis, value.slice(index + 1, end));
          parent.append(emphasis);
          index = end + 1;
          continue;
        }
      }
      if (value[index] === "`") {
        const end = value.indexOf("`", index + 1);
        if (end >= index + 2) {
          const code = document.createElement("code");
          code.textContent = value.slice(index + 1, end);
          parent.append(code);
          index = end + 1;
          continue;
        }
      }
      if (value[index] === "[") {
        const close = value.indexOf("](", index + 1);
        const end = close < 0 ? -1 : value.indexOf(")", close + 2);
        if (close > index + 1 && end > close + 2) {
          const linkText = document.createElement("span");
          appendInline(linkText, value.slice(index + 1, close));
          parent.append(linkText);
          index = end + 1;
          continue;
        }
      }
      let end = index + 1;
      while (end < value.length && !"*`[".includes(value[end])) end += 1;
      parent.append(document.createTextNode(value.slice(index, end)));
      index = end;
    }
  }

  function appendLine(parent, line) {
    appendInline(parent, line);
  }

  function renderMarkdown(value, target) {
    target.replaceChildren();
    const lines = String(value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
    let index = 0;
    let hasBlock = false;
    const beginBlock = () => {
      if (hasBlock) target.append(document.createTextNode("\n"));
      hasBlock = true;
    };
    while (index < lines.length) {
      const line = lines[index];
      const fence = line.match(FENCE_RE);
      if (fence) {
        const marker = fence[1][0];
        const closing = new RegExp(`^ {0,3}${marker}{${fence[1].length},}[ \\t]*$`);
        const codeLines = [];
        index += 1;
        while (index < lines.length && !closing.test(lines[index])) codeLines.push(lines[index++]);
        if (index < lines.length) index += 1;
        beginBlock();
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.append(code);
        target.append(pre);
        continue;
      }
      const heading = line.match(HEADING_RE);
      if (heading) {
        beginBlock();
        const element = document.createElement(`h${heading[1].length}`);
        appendLine(element, heading[2]);
        target.append(element);
        index += 1;
        continue;
      }
      const unordered = line.match(UL_RE);
      const ordered = line.match(OL_RE);
      if (unordered || ordered) {
        beginBlock();
        const list = document.createElement(unordered ? "ul" : "ol");
        let hasItem = false;
        while (index < lines.length) {
          const match = lines[index].match(unordered ? UL_RE : OL_RE);
          if (!match) break;
          if (hasItem) list.append(document.createTextNode("\n"));
          const item = document.createElement("li");
          appendLine(item, match[1]);
          list.append(item);
          hasItem = true;
          index += 1;
        }
        target.append(list);
        continue;
      }
      beginBlock();
      const paragraph = document.createElement("div");
      paragraph.className = "cn-paragraph";
      appendLine(paragraph, line);
      index += 1;
      while (index < lines.length && !lines[index].match(FENCE_RE) && !lines[index].match(HEADING_RE)
        && !lines[index].match(UL_RE) && !lines[index].match(OL_RE)) {
        // The text node keeps Range.toString() equal to the server projection.
        paragraph.append(document.createElement("br"), document.createTextNode("\n"));
        appendLine(paragraph, lines[index++]);
      }
      target.append(paragraph);
    }
  }

  function articleText(article) {
    return typeof article.innerText === "string" ? article.innerText : article.textContent || "";
  }

  function collapsedText(value) {
    const text = String(value ?? "");
    let normalized = "";
    const map = [];
    let whitespaceStart = -1;
    for (let index = 0; index < text.length; index += 1) {
      if (/\s/.test(text[index])) {
        if (whitespaceStart < 0) whitespaceStart = index;
        continue;
      }
      if (whitespaceStart >= 0 && normalized.length > 0) {
        normalized += " ";
        map.push({ start: whitespaceStart, end: index });
      }
      whitespaceStart = -1;
      normalized += text[index];
      map.push({ start: index, end: index + 1 });
    }
    return { text: normalized, map };
  }

  function highlightLiteral(article, value, { whitespaceInsensitive = false, caseInsensitive = false } = {}) {
    if (!article || typeof value !== "string" || value.length === 0) return 0;
    const textContent = () => {
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let text = "";
      let node;
      while ((node = walker.nextNode())) {
        nodes.push({ node, start: text.length, end: text.length + node.data.length });
        text += node.data;
      }
      return { nodes, text };
    };
    const initial = textContent();
    const matches = [];
    const projection = whitespaceInsensitive ? collapsedText(initial.text) : {
      text: initial.text,
      map: Array.from({ length: initial.text.length }, (_value, index) => ({ start: index, end: index + 1 })),
    };
    const haystack = caseInsensitive ? projection.text.toLocaleLowerCase() : projection.text;
    const needle = caseInsensitive ? value.toLocaleLowerCase() : value;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      const startMap = projection.map[at];
      const endMap = projection.map[end - 1];
      if (startMap && endMap) matches.push([startMap.start, endMap.end]);
    }
    let highlighted = 0;
    // Wrap each covered text node separately, so a match that spans list
    // items or blocks never moves element boundaries (a <mark> spanning <li>
    // elements would break the list).
    for (const [start, end] of matches.reverse()) {
      const current = textContent();
      const covered = current.nodes.filter((entry) => entry.end > start && entry.start < end);
      let wrapped = 0;
      for (const entry of covered.reverse()) {
        const parentTag = entry.node.parentNode?.nodeName;
        if (parentTag === "UL" || parentTag === "OL") continue;
        const localStart = Math.max(0, start - entry.start);
        const localEnd = Math.min(entry.node.data.length, end - entry.start);
        if (localEnd <= localStart) continue;
        let target = entry.node;
        if (localEnd < target.data.length) target.splitText(localEnd);
        if (localStart > 0) target = target.splitText(localStart);
        const mark = document.createElement("mark");
        target.parentNode.insertBefore(mark, target);
        mark.append(target);
        wrapped += 1;
      }
      if (wrapped > 0) highlighted += 1;
    }
    return highlighted;
  }

  global.CollaborativeNotesRenderer = Object.freeze({ renderMarkdown, projectMarkdown, articleText, highlightLiteral });
})(globalThis);
