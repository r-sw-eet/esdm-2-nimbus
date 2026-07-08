import { assertEquals, assertThrows } from '@std/assert';
import { compileFeelToTs } from '../src/adapter/nimbus/feelTs.ts';
import { FeelError, parseFeel, validateFeel } from '../src/feel/feel.ts';

Deno.test('parses comparisons with clock functions', () => {
    assertEquals(parseFeel('validUntil >= today()'), {
        t: 'bin',
        op: '>=',
        l: { t: 'id', name: 'validUntil' },
        r: { t: 'call', fn: 'today' },
    });
});

Deno.test('precedence: or is looser than and', () => {
    const ast = parseFeel('a = 1 and b = 2 or c = 3');
    assertEquals(ast.t, 'or');
});

Deno.test('parses membership over literal lists', () => {
    assertEquals(parseFeel('status in ["sent", "drafted"]'), {
        t: 'in',
        e: { t: 'id', name: 'status' },
        list: [{ t: 'str', v: 'sent' }, { t: 'str', v: 'drafted' }],
    });
});

Deno.test('parses not(...) and parentheses', () => {
    assertEquals(parseFeel('not (paid = true)'), {
        t: 'not',
        e: { t: 'bin', op: '=', l: { t: 'id', name: 'paid' }, r: { t: 'bool', v: true } },
    });
});

Deno.test('rejects malformed expressions', () => {
    assertThrows(() => parseFeel('('), FeelError);
    assertThrows(() => parseFeel('a >'), FeelError);
    assertThrows(() => parseFeel('a ~ b'), FeelError);
    assertThrows(() => parseFeel('a in [1, 2'), FeelError);
});

Deno.test('validate binds identifiers against allowed fields', () => {
    const ast = parseFeel('validUntil >= today() and status = "sent"');
    assertEquals(validateFeel(ast, ['validUntil', 'status']), []);
    assertEquals(validateFeel(ast, ['status']), ['unknown field "validUntil"']);
});

Deno.test('compiles to TypeScript over state', () => {
    assertEquals(
        compileFeelToTs(parseFeel('validUntil >= today()')),
        '(state.validUntil! >= new Date().toISOString().slice(0, 10))',
    );
    assertEquals(
        compileFeelToTs(parseFeel('status in ["sent"] or total != 0')),
        "(['sent'].includes((state.status ?? '')) || (state.total! !== 0))",
    );
    assertEquals(compileFeelToTs(parseFeel('paid = true')), '(state.paid! === true)');
});
