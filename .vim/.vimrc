syntax on
set background=dark
colorscheme hybrid

" --- プロンプト編集を快適にする最小セット ---
set wrap linebreak          " 長文を単語単位で折り返す
set clipboard=unnamed       " macOSのクリップボードと yank/paste を共有
set number                  " 行番号
set incsearch ignorecase    " インクリメンタルサーチ＋大小無視
set backspace=indent,eol,start  " Backspaceを普通に効かせる
set scrolloff=3             " カーソル周辺に3行の余白
let mapleader=" "           " リーダーキー＝スペース（自作マップの土台）
