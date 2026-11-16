-- OpenSCAD formatting via clang-format.
-- OpenSCAD has no dedicated formatter, but its syntax is C-like enough that
-- clang-format produces clean, consistent output. We define a *dedicated*
-- formatter (rather than reusing the shared `clang_format`) so that the inline
-- style here can't interfere with how clang-format treats real C/C++ files,
-- which should keep respecting their own project-local .clang-format.
return {
  {
    "stevearc/conform.nvim",
    opts = {
      formatters_by_ft = {
        openscad = { "scad_clang_format" },
      },
      formatters = {
        scad_clang_format = {
          command = "clang-format",
          stdin = true,
          -- --assume-filename forces clang-format to parse as C++ (it doesn't
          -- know the .scad extension). The inline style pins a 4-space,
          -- 100-column layout that reads well for OpenSCAD modules.
          args = {
            "--assume-filename=scad.cpp",
            "--style={BasedOnStyle: LLVM,"
              .. " IndentWidth: 4,"
              .. " ColumnLimit: 100,"
              .. " AllowShortBlocksOnASingleLine: Never,"
              .. " AllowShortFunctionsOnASingleLine: None,"
              .. " AllowShortIfStatementsOnASingleLine: false,"
              .. " AllowShortLoopsOnASingleLine: false}",
          },
        },
      },
    },
  },
}
