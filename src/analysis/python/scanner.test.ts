import { describe, expect, it } from "vitest";

import { collectDefinitions, collectImports, scanPython } from "./scanner";

/**
 * The scanner, on the inputs that break a regex sweep.
 *
 * Every case here is one a pile of independent regexes gets wrong silently —
 * which is the reason the scanner has state at all. A wrong node list cannot be
 * detected by anything downstream: the map simply shows functions that are not
 * there, or misses the ones that are, and looks exactly as confident either way.
 */

function definitionsOf(source: string) {
  return collectDefinitions(scanPython(source));
}

function importsOf(source: string) {
  return collectImports(scanPython(source));
}

function namesOf(source: string): string[] {
  return definitionsOf(source).map((definition) =>
    definition.container ? `${definition.container}.${definition.name}` : definition.name,
  );
}

describe("what counts as a declaration", () => {
  it("takes top-level def and class", () => {
    expect(
      namesOf(
        [
          "def place_order(symbol):",
          "    return symbol",
          "",
          "class Broker:",
          "    pass",
        ].join("\n"),
      ),
    ).toEqual(["place_order", "Broker"]);
  });

  it("gives a method its class as container", () => {
    const found = definitionsOf(
      ["class Broker:", "    def place(self, order):", "        return order"].join("\n"),
    );

    expect(found.map((one) => [one.name, one.container])).toEqual([
      ["Broker", undefined],
      ["place", "Broker"],
    ]);
  });

  it("does NOT take a def nested inside another def", () => {
    // Indentation is the only signal there is. A regex for `^\s*def ` admits
    // the closure, and the node list is then wrong in a way nothing downstream
    // can notice.
    const found = namesOf(
      [
        "def outer(items):",
        "    def inner(one):",
        "        return one",
        "    return [inner(x) for x in items]",
      ].join("\n"),
    );

    expect(found).toEqual(["outer"]);
  });

  it("gives a nested class its outer class as container", () => {
    // `ArrowStyle.Curve` in matplotlib, `Git.AutoInterrupt` in GitPython: a
    // class inside a class is a real, addressable name and belongs on the map
    // the same way a method does. Its own methods are one level deeper and get
    // no node, because a ref carries one container and not a chain.
    const found = definitionsOf(
      [
        "class ArrowStyle:",
        "    class Curve:",
        "        def __init__(self):",
        "            pass",
      ].join("\n"),
    );

    expect(found.map((one) => [one.name, one.container, one.kind])).toEqual([
      ["ArrowStyle", undefined, "class"],
      ["Curve", "ArrowStyle", "class"],
    ]);
  });

  it("does not take a method of a class defined inside a function", () => {
    expect(
      namesOf(
        [
          "def build():",
          "    class Hidden:",
          "        def run(self):",
          "            return 1",
          "    return Hidden",
        ].join("\n"),
      ),
    ).toEqual(["build"]);
  });

  it("takes a def under a module-level if, because that is not a scope", () => {
    expect(
      namesOf(
        ["import sys", "", "if sys.version_info > (3, 9):", "    def fast():", "        return 1"].join(
          "\n",
        ),
      ),
    ).toEqual(["fast"]);
  });

  it("reads tab indentation the way Python does", () => {
    expect(namesOf(["class Broker:", "\tdef place(self):", "\t\treturn 1"].join("\n"))).toEqual([
      "Broker",
      "Broker.place",
    ]);
  });

  it("handles async def, decorators and a multi-line signature", () => {
    const found = definitionsOf(
      [
        "@retry(times=3)",
        "@app.route('/orders')",
        "async def submit(",
        "    order,",
        "    *,",
        "    dry_run=False,",
        "):",
        "    return order",
      ].join("\n"),
    );

    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("submit");
    expect(found[0].isAsync).toBe(true);
    // The range opens on the first decorator: that is what a person would point
    // at if asked to show the function.
    expect(found[0].startLine).toBe(1);
    expect(found[0].endLine).toBe(8);
    expect(found[0].decorators).toEqual(["retry", "app.route"]);
  });

  it("closes a definition at the dedent, not at the end of the file", () => {
    const found = definitionsOf(
      ["def first():", "    return 1", "", "", "def second():", "    return 2"].join("\n"),
    );

    expect(found[0].startLine).toBe(1);
    // Line 2, not line 4: trailing blank lines belong to nobody.
    expect(found[0].endLine).toBe(2);
    expect(found[1].startLine).toBe(5);
  });
});

describe("strings and comments are not code", () => {
  it("ignores a def inside a docstring", () => {
    expect(
      namesOf(
        [
          '"""Usage.',
          "",
          "def example():",
          "    pass",
          '"""',
          "def real():",
          "    return 1",
        ].join("\n"),
      ),
    ).toEqual(["real"]);
  });

  it("ignores an import inside a docstring", () => {
    expect(
      importsOf(
        ["'''", "import broker", "from .db import save", "'''", "import os"].join("\n"),
      ).map((one) => one.module),
    ).toEqual(["os"]);
  });

  it("ignores a commented-out import", () => {
    expect(importsOf(["# import broker", "import os  # from db import save"].join("\n"))).toEqual([
      { level: 0, module: "os", names: [], fromForm: false, line: 2 },
    ]);
  });

  it("does not mistake a # inside a string for a comment", () => {
    // Getting this wrong truncates the line and loses whatever followed, which
    // for a one-line `x = "#"; import broker` is a whole import.
    expect(importsOf(['TAG = "# not a comment"', "import broker"].join("\n"))).toHaveLength(1);
  });

  it("keeps reading after a raw string that ends in a backslash escape", () => {
    expect(namesOf(['PATTERN = r"\\""', "def after():", "    return 1"].join("\n"))).toEqual([
      "after",
    ]);
  });

  it("recovers from an unterminated single-quoted string instead of eating the file", () => {
    expect(namesOf(["BROKEN = 'oops", "def after():", "    return 1"].join("\n"))).toEqual([
      "after",
    ]);
  });
});

describe("statements written across lines", () => {
  it("reads a parenthesised import list with a trailing comma", () => {
    const [statement] = importsOf(
      ["from broker.orders import (", "    place_order,", "    cancel_order,", ")"].join("\n"),
    );

    expect(statement.module).toBe("broker.orders");
    expect(statement.names.map((one) => one.name)).toEqual(["place_order", "cancel_order"]);
    expect(statement.line).toBe(1);
  });

  it("reads a backslash continuation", () => {
    const [statement] = importsOf(["from broker import \\", "    place_order"].join("\n"));

    expect(statement.module).toBe("broker");
    expect(statement.names.map((one) => one.name)).toEqual(["place_order"]);
  });

  it("reads every form of the statement", () => {
    const found = importsOf(
      [
        "import os",
        "import numpy as np",
        "import a.b.c",
        "from . import db",
        "from .models import User",
        "from ..shared.util import clean as scrub",
        "from broker import *",
        "import json, csv",
      ].join("\n"),
    );

    expect(found.map((one) => [one.level, one.module, one.alias])).toEqual([
      [0, "os", undefined],
      [0, "numpy", "np"],
      [0, "a.b.c", undefined],
      [1, "", undefined],
      [1, "models", undefined],
      [2, "shared.util", undefined],
      [0, "broker", undefined],
      [0, "json", undefined],
      [0, "csv", undefined],
    ]);
    expect(found[5].names).toEqual([{ name: "clean", alias: "scrub" }]);
    expect(found[6].names).toEqual([{ name: "*" }]);
  });

  it("does not mistake an identifier starting with from or import", () => {
    expect(importsOf(["from_date = 1", "imported = True"].join("\n"))).toEqual([]);
  });

  it("reads an import written on the same line as its if", () => {
    // Measured against CPython's own `ast` over 4,000 real files, this was the
    // single import the scanner missed — `telnetlib.py` writes
    // `if not re: import re`. `if TYPE_CHECKING: import x` is the everyday form
    // of the same thing.
    expect(
      importsOf(
        [
          "from typing import TYPE_CHECKING",
          "if TYPE_CHECKING: import broker",
          "try: import ujson",
          "except ImportError: import json",
        ].join("\n"),
      ).map((one) => one.module),
    ).toEqual(["typing", "broker", "ujson", "json"]);
  });

  it("keeps an import that lives inside a function body", () => {
    // A deferred import to break a cycle is ordinary Python, and the file does
    // depend on what it names.
    expect(
      importsOf(["def load():", "    from .db import save", "    return save"].join("\n")).map(
        (one) => one.module,
      ),
    ).toEqual(["db"]);
  });
});

describe("the stripped source the LLM pass checks against", () => {
  it("empties string contents and drops comments, line by line", () => {
    const scan = scanPython(
      ['NOTE = "call place_order here"', "# place_order()", "place_order()"].join("\n"),
    );

    expect(scan.code[0]).toBe('NOTE = ""');
    expect(scan.code[1]).toBe("");
    expect(scan.code[2]).toBe("place_order()");
  });
});
