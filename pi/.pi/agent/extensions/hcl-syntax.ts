/**
 * Pi extension: HCL/Terraform syntax highlighting
 *
 * Registers an HCL language grammar with highlight.js (v10.7.3) which is used
 * by cli-highlight for code block rendering in pi's TUI. Without this, ```hcl
 * code blocks fall back to auto-detection with poor results.
 *
 * The grammar is adapted from:
 *   https://github.com/highlightjs/highlightjs-terraform
 * with enhancements for HCL2 (Terraform 0.12+) syntax including:
 *   - for expressions, splat operators
 *   - built-in functions (coalesce, length, ceil, etc.)
 *   - heredoc strings
 *   - type constructors (object, map, list, set, tuple)
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function hclLanguage(hljs: any) {
  const NUMBERS = {
    className: "number",
    begin: "\\b\\d+(\\.\\d+)?",
    relevance: 0,
  };

  const HEREDOC = {
    className: "string",
    begin: "<<-?\\s*[A-Za-z_][A-Za-z_0-9]*",
    end: "^\\s*[A-Za-z_][A-Za-z_0-9]*$",
    relevance: 0,
  };

  const STRING_INTERPOLATION = {
    className: "subst",
    begin: "\\$\\{",
    end: "\\}",
    keywords: {
      keyword:
        "for in if",
      literal: "true false null",
    },
    contains: [], // filled below
  };

  const STRINGS = {
    className: "string",
    begin: '"',
    end: '"',
    contains: [
      hljs.BACKSLASH_ESCAPE,
      STRING_INTERPOLATION,
    ],
  };

  STRING_INTERPOLATION.contains = [
    NUMBERS,
    STRINGS,
    {
      className: "built_in",
      begin:
        "\\b(abs|ceil|floor|log|max|min|pow|signum|" +
        "chomp|format|formatlist|indent|join|lower|upper|regex|regexall|replace|split|" +
        "strrev|substr|title|trim|trimprefix|trimsuffix|trimspace|" +
        "alltrue|anytrue|chunklist|coalesce|coalescelist|compact|concat|contains|" +
        "distinct|element|flatten|index|keys|length|list|lookup|map|matchkeys|merge|" +
        "one|range|reverse|setintersection|setproduct|setsubtract|setunion|slice|sort|" +
        "sum|transpose|values|zipmap|" +
        "base64decode|base64encode|base64gzip|csvdecode|jsondecode|jsonencode|" +
        "textdecodebase64|textencodebase64|urlencode|yamldecode|yamlencode|" +
        "abspath|dirname|pathexpand|basename|file|fileexists|fileset|filebase64|" +
        "templatefile|" +
        "formatdate|timeadd|timecmp|timestamp|plantimestamp|" +
        "base64sha256|base64sha512|bcrypt|filebase64sha256|filebase64sha512|" +
        "filemd5|filesha1|filesha256|filesha512|md5|rsadecrypt|sha1|sha256|sha512|" +
        "uuid|uuidv5|" +
        "cidrhost|cidrnetmask|cidrsubnet|cidrsubnets|" +
        "can|defaults|nonsensitive|sensitive|tobool|tolist|tomap|tonumber|toset|tostring|" +
        "try|type|" +
        "endswith|startswith|strcontains|" +
        "object|tuple|set|optional|" +
        "templatestring|plantimestamp|issensitive)\\s*\\(",
      end: "\\(",
      returnEnd: true,
    },
  ];

  const BLOCK_LABEL = {
    className: "string",
    begin: '"',
    end: '"',
  };

  const BLOCK_TYPE = {
    className: "keyword",
    begin:
      "\\b(resource|data|variable|output|locals|module|provider|terraform|" +
      "moved|import|check|removed|ephemeral)\\b",
  };

  const ATTRIBUTE = {
    className: "attr",
    begin: "\\b[A-Za-z_][A-Za-z_0-9]*\\s*=(?!=)",
    end: "=",
    excludeEnd: true,
    relevance: 0,
  };

  const FUNCTION_CALL = {
    className: "built_in",
    begin:
      "\\b(abs|ceil|floor|log|max|min|pow|signum|" +
      "chomp|format|formatlist|indent|join|lower|upper|regex|regexall|replace|split|" +
      "strrev|substr|title|trim|trimprefix|trimsuffix|trimspace|" +
      "alltrue|anytrue|chunklist|coalesce|coalescelist|compact|concat|contains|" +
      "distinct|element|flatten|index|keys|length|list|lookup|map|matchkeys|merge|" +
      "one|range|reverse|setintersection|setproduct|setsubtract|setunion|slice|sort|" +
      "sum|transpose|values|zipmap|" +
      "base64decode|base64encode|base64gzip|csvdecode|jsondecode|jsonencode|" +
      "textdecodebase64|textencodebase64|urlencode|yamldecode|yamlencode|" +
      "abspath|dirname|pathexpand|basename|file|fileexists|fileset|filebase64|" +
      "templatefile|" +
      "formatdate|timeadd|timecmp|timestamp|plantimestamp|" +
      "base64sha256|base64sha512|bcrypt|filebase64sha256|filebase64sha512|" +
      "filemd5|filesha1|filesha256|filesha512|md5|rsadecrypt|sha1|sha256|sha512|" +
      "uuid|uuidv5|" +
      "cidrhost|cidrnetmask|cidrsubnet|cidrsubnets|" +
      "can|defaults|nonsensitive|sensitive|tobool|tolist|tomap|tonumber|toset|tostring|" +
      "try|type|" +
      "endswith|startswith|strcontains|" +
      "object|tuple|set|optional|" +
      "templatestring|plantimestamp|issensitive)\\s*\\(",
    end: "\\(",
    returnEnd: true,
  };

  const VARIABLE_REF = {
    className: "variable",
    begin: "\\b(var|local|data|module|each|self|count|path|terraform)\\.[A-Za-z_][A-Za-z_0-9.]*",
    relevance: 0,
  };

  return {
    aliases: ["hcl", "tf", "tfvars"],
    keywords: {
      keyword: "resource data variable output locals module provider terraform moved import check removed ephemeral for in if dynamic content",
      literal: "true false null",
      type: "string number bool list map set object tuple any",
    },
    contains: [
      hljs.COMMENT("#", "$"),
      hljs.COMMENT("//", "$"),
      hljs.COMMENT("/\\*", "\\*/"),
      BLOCK_TYPE,
      ATTRIBUTE,
      FUNCTION_CALL,
      VARIABLE_REF,
      HEREDOC,
      STRINGS,
      NUMBERS,
      BLOCK_LABEL,
    ],
  };
}

export default function (pi: ExtensionAPI) {
  try {
    // The extension runs inside pi's process, so process.argv[1] is pi's CLI entry
    // point. However, when pi is installed globally via npm, the bin entry is a
    // *symlink* (e.g. .../bin/pi -> .../pi-coding-agent/dist/cli.js). createRequire
    // uses the path literally without following symlinks, so it can't find
    // node_modules from the bin/ directory. We resolve the real path first.
    const piEntryPoint = realpathSync(process.argv[1]);
    const requireFromPi = createRequire(piEntryPoint);
    const cliHighlightPath = requireFromPi.resolve("cli-highlight");
    const requireFromCliHighlight = createRequire(cliHighlightPath);
    const hljs = requireFromCliHighlight("highlight.js");

    // Register HCL as both "hcl" and "terraform" (with aliases for tf/tfvars)
    hljs.registerLanguage("hcl", hclLanguage);
    hljs.registerLanguage("terraform", hclLanguage);
  } catch (e: any) {
    // If patching fails, log but don't crash pi
    console.error(`[hcl-syntax] Failed to register HCL language: ${e.message}`);
  }
}
