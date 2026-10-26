/**
 * JSON as a person's editor or another tool may have written it (#470): a
 * UTF-8 byte-order mark before it, which Windows PowerShell 5.1 and some
 * editors write, is not part of the JSON and is dropped. Throws as
 * `JSON.parse` does for anything else.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text.startsWith("﻿") ? text.slice(1) : text);
}
