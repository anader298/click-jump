" Click Jump: follows clicks from the preview, moves to the line and flashes it.
if !has('timers') || empty($CLICK_JUMP_SIGNAL)
  finish
endif

function! s:Colors() abort
  highlight default ClickJumpFlash ctermbg=178 ctermfg=0 guibg=#ffc400 guifg=#000000
endfunction
call s:Colors()
augroup ClickJump
  autocmd!
  autocmd ColorScheme * call s:Colors()
augroup END

let s:signal = $CLICK_JUMP_SIGNAL
let s:last = ''
let s:match = -1
let s:match_win = -1
let s:clear_timer = -1

function! s:Clear(...) abort
  if s:match != -1
    if win_id2win(s:match_win) > 0
      silent! call matchdelete(s:match, s:match_win)
    endif
    let s:match = -1
    redraw
  endif
endfunction

function! s:Poll(timer) abort
  if !filereadable(s:signal)
    return
  endif
  try
    let l:msg = json_decode(join(readfile(s:signal), ''))
  catch
    return
  endtry
  if type(l:msg) != v:t_dict || get(l:msg, 'id', '') ==# s:last
    return
  endif
  let s:last = l:msg.id
  " Never interrupt a command line or a pending prompt.
  if mode() !~# '^[nvVi]'
    return
  endif
  if resolve(fnamemodify(l:msg.file, ':p')) !=# resolve(expand('%:p'))
    execute 'silent hide edit' fnameescape(l:msg.file)
  endif
  if exists('*setcursorcharpos')
    call setcursorcharpos(l:msg.line, l:msg.col)
  else
    call cursor(l:msg.line, l:msg.col)
  endif
  normal! zz
  call s:Clear()
  let s:match = matchaddpos('ClickJumpFlash', [l:msg.line])
  let s:match_win = win_getid()
  redraw
  call timer_stop(s:clear_timer)
  let s:clear_timer = timer_start(1100, function('s:Clear'))
endfunction

call timer_start(120, function('s:Poll'), {'repeat': -1})
