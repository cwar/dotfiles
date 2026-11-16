return {
  {
    "mfussenegger/nvim-jdtls",
    opts = function(_, opts)
      table.insert(opts.cmd, 2, "--java-executable=/usr/bin/java")

      local fallback_root_dir = opts.root_dir
      opts.root_dir = function(path)
        return vim.fs.root(path, { ".project" }) or fallback_root_dir(path)
      end
    end,
  },
}
