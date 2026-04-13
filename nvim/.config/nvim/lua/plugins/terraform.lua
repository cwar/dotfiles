return {
  -- disable terraform_validate linter by directly patching nvim-lint at runtime
  {
    "mfussenegger/nvim-lint",
    ft = { "terraform", "tf" },
    init = function()
      vim.api.nvim_create_autocmd("FileType", {
        pattern = { "terraform", "tf" },
        once = true,
        callback = function()
          local ok, lint = pcall(require, "lint")
          if ok then
            lint.linters_by_ft.terraform = {}
            lint.linters_by_ft.tf = {}
          end
        end,
      })
    end,
  },
}
