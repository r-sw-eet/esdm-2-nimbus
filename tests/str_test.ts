import { assertEquals } from '@std/assert';
import { camel, snake, studly } from '../src/support/str.ts';

Deno.test('studly turns kebab-case into StudlyCase', () => {
    assertEquals(studly('order-item'), 'OrderItem');
    assertEquals(studly('task'), 'Task');
    assertEquals(studly('quality-check_passed thing'), 'QualityCheckPassedThing');
});

Deno.test('camel turns kebab-case into camelCase', () => {
    assertEquals(camel('order-item'), 'orderItem');
    assertEquals(camel('valid-until'), 'validUntil');
    assertEquals(camel('id'), 'id');
});

Deno.test('snake turns kebab-case and camelCase into snake_case', () => {
    assertEquals(snake('order-item'), 'order_item');
    assertEquals(snake('orderItem'), 'order_item');
    assertEquals(snake('rm2Widget'), 'rm2_widget');
});
