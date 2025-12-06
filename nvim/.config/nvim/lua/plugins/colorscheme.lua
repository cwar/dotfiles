return {
  -- add tokyo night
  { "folke/tokyonight.nvim" },

  -- Configure LazyVim to load tokyo night
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "tokyonight",
    },
  },
}
