
# Tea++

DSL / programming langage for [Mad Tea Synth](https://github.com/teadrinker/mad-tea-synth), and possibly a future version of [Mad Tea Lab](https://madtealab.com)...

Try it out online: [Normal VM](https://teadrinker.github.io/tea-plus-plus/test/ui_demo/?page=test) / [Reactive VM](https://teadrinker.github.io/tea-plus-plus/test/ui_demo/?page=reactive)

Source code is in [Mad Tea Synth Repo](https://github.com/teadrinker/mad-tea-synth/tree/main/source/vm)

**Parts:**

 * **Compiler** (`vm.c`) 
 * **Main VM** (`vm_run.c`) - interpreter, walks typed IR
 * (Reactive VM (`rvm/`/`vm_reactive.h`) - work in progress)
 * Source code backends:
    - **C** (`vm_emit_c.c`) 
    - **js / Lua 5.5** (`vm_emit_script.c`) - No i64 in JS, no f32 in Lua.
    - **GLSL ES 3.00 / HLSL SM5** (`vm_emit_shader.c`) - no f64 / i64, strings, structs or recursion.
    - **CurlyWas** (`vm_emit_curlywas.c`) - not complete, untested

## Language

- **Expression-first** - the last expression in a body is its value; `return` is optional. `if` is a statement, so use `?:` for a value.
- **Assignment** - `x = expr`; a name is declared by its first assignment.
- **Types** - `i32`, `i64`, `f32`, `f64`, and fixed-point `fxN` (e.g. `fx16`, `fx22`); `u8` / `u16` as packed array element types (`[16]u8`).
- **Annotation** - `x : fx16 = 0.5`, and on parameters: `f = (x:fx16) => x*2`.
- **Cast** - `t as fx16` (Rust-style), `(int)(t)` / `int(t)`/ `int t` (int/float/double are alias of i32/f32/f64)
- **Functions** - `f = (a, b) => a + b`, or an indented multi-line body; default args: `(a, b = 2) =>`; call as `f(x, y)` or `f x, y`.
- **Blocks** - indentation, or braces; `if c then …`, `while c do …`, and the paren forms `if(c) {…}`, `while(c) {…}`, with no space before the `(`.
- **Control flow** - `if` / `else`, `while`, `for`, `break`, `continue`, `return`.
- **`for`** - `for(i = 0; i < n; i++)`, `for i in 0..n` (exclusive), `for i in 0..=n` (inclusive).
- **`for … in`** - `for x in xs`, and `for i, x in xs` for index and value.
- **Arrays** - `a = [1,2,3]`, `a[i]`, `a.len`; nested `[[1,2],[3,4]]`, where `a[i]` is a row.
- **Array params** - an unannotated array parameter is a read-only view; `(a: [])` or `(a: []i32)` to write through it.
- **Elementwise** - `+ - * / % & | ^ == !=` work on whole arrays, with scalar broadcast.
- **Swizzle** - `v.x`, `v.zy`, `c.rgb` on any flat array, GLSL-style.
- **Slices** - `a[start..end]` or `slice(a, start, len)`; both are views, no copy.
- **Structs** - `struct pt { x: f32, y: f32 }`, then `p : pt`, `p.x = 2`; `ref pt` parameters write through.
- **Splat** - `f(1, ...xs)`, `[0, ...xs]`, and rest parameters `(a, ...rest) =>`; the count must be known at compile time.
- **`map(xs, f)`** - `map([1,2,3], (x) => x * 10)`, also over a range `map(0..4, f)`.
- **Strings** - `"text"` is a `[]u8`; `~` concatenates, `~=` appends.
- **`str(x)` / `str(x, d)`** - number to string, `d` decimal places (default 3 for floats).
- **`print(x, …)`** - to the host's output; dropped from exported code.
- **Division** - `/` is real division, so `1 / 3` is 0.333 even on integers; `/~` truncates like C's integer `/`, `/%` floors; `/x` is `1 / x`.
- **Remainder** - `%` pairs with `/~` (C remainder), `%%` pairs with `/%` (floored, takes the divisor's sign).
- **Operators** - `+ - * / /~ /% % %%`, `**`, `& | ^ << >> >>>`, `&& || !`, `< <= > >= == != === !==`, `?:`.
- **Update operators** - `++ --`, and `+= -= *= /= /~= /%= %= %%= ~= &= |= ^= <<= >>=`.
- **`const name = expr`** - folded at compile time; costs nothing and cannot be assigned to; visible in its body and functions written inside it.
- **`pi`, `tau`** - built-in constants; a declaration of the same name shadows them.


### Directives

- **`#define NAME expr`** - substitution into the syntax tree, resolved late.
- **`#rewire f64 -> fx16`** - retype annotations *and* literals; `#rewire type …` / `#rewire literal …` for one or the other; `number -> f64` catches all four scalar kinds.
- **`#push …` / `#pop`** - save state, apply, restore later.
- **`#enable …` / `#disable …`** - toggle a compile option:
    - **`safe_div_by_zero`** *(on)* - check the divisor and return 0 instead of trapping.
    - **`inline_powers`** *(on)* - expand `x ** <small int>` into repeated multiplication.
    - **`identity_elim`** *(on)* - drop `+0`, `*1` and friends instead of compiling them; `0 * x` is 0, assuming finite floats.
    - **`const_folding`** *(on)* - evaluate an operator on two constants at compile time.
    - **`const_precise`** *(on)* - evaluate an annotated const at full f64 precision, then round once to its type.
    - **`auto_const`** *(on)* - a top-level `x = 5` never written again becomes a `const`.
    - **`auto_pack`** *(on)* - shrink a never-written constant array to the narrowest `uN` that holds it.
    - **`auto_vec`** *(on)* - elementwise array arithmetic; disabling makes an array operand an error.
    - **`swizzle`** *(on)* - `v.x`, `v.zy`, `c.rgb` on arrays.
    - **`unroll`** *(on)* - a `for` with constant bounds of at most 4 passes compiles without a loop.
    - **`fx_i64_widening`** *(on)* - let fixed-point multiply/divide widen through i64 to keep low bits.
    - **`int_wrap`** *(on)* - wrap integer arithmetic to its declared width in the JS/Lua backends.
    - **`c_division`** *(off)* - `/` on two integers truncates, as in C.
    - **`c_shifts`** *(off)* - shift counts as C takes them: not masked, undefined past the width. Off, a count is taken mod the width.
    - **`c_float_to_int`** *(off)* - a float converted to an integer is C's cast, undefined for nan or out of range. Off, it saturates and nan gives 0, as Rust `as` and wasm do.
    - **`c_int_wrap`** *(off)* - exported C does integer `+ - *` and negation through unsigned, so overflow wraps as in the VM. Off, the C stays readable and relies on `-fwrapv`.
    - **`undefined_behaviour`** *(off)* - every C undefined behaviour at once: `c_shifts`, `c_float_to_int`, `safe_div_by_zero` off and `c_int_wrap` off.
    - **`lossy_assignment`** *(off)* - allow silently reassigning a variable to a narrower type.
    - **`strict_indent`** *(off)* - an indented block under a head that takes none becomes an error.
    - **`source_builtins`** *(off)* - compile the step functions from their source definitions instead of calling C, so they specialise per type.
    - **`inline_builtins`** *(off)* - expand small library bodies into the caller instead of calling them.
    - **`capture`** *(off)* - let a `=>` body read the names around it; reactive engine only.


## Example

```
sort = (a: []) =>
    for i, v in a
        j = i - 1
        while j >= 0 && a[j] > v
            a[j + 1] = a[j]
            j--
        a[j + 1] = v

median = (a: []) =>
    sort(a)
    h = a.len /~ 2 // explicit trunc div
    a.len % 2 == 1 ? a[h] : (a[h - 1] + a[h]) / 2

median [7, 3, 9, 1, 4, 8]
```

Changing any type in the array automatically changes types everywhere else.

Behaviour can be tweaked closer to C:

```
#enable c_division          // int / int truncates
#enable undefined_behaviour // native shifts and float casts, unguarded divide
#enable lossy_assignment    // narrowing assignments convert silently
#disable auto_vec           // no array arithmetic
#disable swizzle            // no v.xy

sort = (a: []i32) => {
    for(i = 1; i < a.len; i++) {
        v = a[i];
        j = i - 1;
        while(j >= 0 && a[j] > v) {
            a[j + 1] = a[j];
            j--;
        }
        a[j + 1] = v;
    }
};

median = (a: []i32) => {
    sort(a);
    h = a.len / 2;
    if(a.len % 2 == 1) {
        return (double)(a[h]);
    } else {
        return (a[h - 1] + a[h]) / 2.0;
    }
};

xs = [7, 3, 9, 1, 4, 8];
return median(xs);
```



## Library

- **`exp(x)`, `log(x)`, `sqrt(x)`**
- **`sin(x)`, `cos(x)`, `atan2(y, x)`** 
- **`sin01(x)` / `cos01(x)`** - 0..1 is one full cycle.
- **`pow(a, b)`** - also  `a ** b`.
- **`ipow(a, b)`** - exact integer power.
- **`abs(x)`, `min(a, b)`, `max(a, b)`, `clamp(x, lo, hi)`**
- **`floor(x)`, `frac(x)`, `fmod(a, b)`**

**Other / GLSL derived**

- **`mix(a, b, t)`** - linear interpolation, `a + t*(b-a)`.
- **`dot(a, b)`, `length(v)`, `distance(a, b)`, `normalize(v)`, `cross(a, b)`** - GLSL
- **`reflect(i, n)`, `refract(i, n, eta)`, `faceforward(n, i, nref)`** - GLSL
- **`linearstep(e0, e1, x)`, `smoothstep(…)`, `smootherstep(…)`** - 0→1 ramps of rising smoothness.
- **`linearstepa(…)`, `smoothstepa(…)`, `smootherstepa(…)`** - integrated versions.
- **`sum(xs)`, `mean(xs)`** - over rows, per column.
- **`rotate(p, a)`** - 2D; **`rotateX/Y/Z(p, a)`**, **`euler(p, r)`** - 3D, Z then Y then X.
- **`fromPolar(p)`, `toPolar(p)`** - `[r, angle]` to and from `[x, y]`.
- **`project(p, f)`** - perspective divide, `[x*f/z, y*f/z]`.


