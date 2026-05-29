# Third-Party Licenses

This skill bundles the following third-party software locally so that it can run
fully offline (no CDN / external requests at runtime).

## marked

- File: `lib/marked.min.js`
- Version: 12.0.2
- License: MIT
- Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/marked)
- Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

```
The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Design inspiration

The server / live-reload / comment-inbox architecture is inspired by
`paraschopra/make-pages-interactive` (MIT License, Copyright (c) 2026 Paras Chopra).
No source code is copied verbatim; the implementation here is original and
adapted to the single-file, non-destructive, markdown-aware requirements of this
skill.
