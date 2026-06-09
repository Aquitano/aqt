import { describe, expect, test } from 'bun:test';
import { getTemplates } from '../templates.ts';

describe('getTemplates', () => {
  test('with hono: true returns hono files and landing page', () => {
    const files = getTemplates({ hono: true });
    const keys = Object.keys(files);

    expect(keys).toContain('src/app/page.tsx');
    expect(keys).toContain('src/lib/hono/index.ts');
    expect(keys).toContain('src/lib/hono/routes/health.ts');
    expect(keys).toContain('src/lib/hono/routes/users.ts');
    expect(keys).toContain('src/app/api/[[...route]]/route.ts');
    expect(keys).toHaveLength(5);
  });

  test('with hono: false returns only landing page', () => {
    const files = getTemplates({ hono: false });
    const keys = Object.keys(files);

    expect(keys).toContain('src/app/page.tsx');
    expect(keys).not.toContain('src/lib/hono/index.ts');
    expect(keys).toHaveLength(1);
  });

  test('all template values are non-empty strings', () => {
    const honoTrue = getTemplates({ hono: true });
    const honoFalse = getTemplates({ hono: false });

    for (const [path, content] of Object.entries(honoTrue)) {
      expect(content, `template ${path} is empty`).toBeTruthy();
      expect(typeof content).toBe('string');
    }
    for (const [path, content] of Object.entries(honoFalse)) {
      expect(content, `template ${path} is empty`).toBeTruthy();
      expect(typeof content).toBe('string');
    }
  });

  test('landing page template contains AQT Stack branding', () => {
    const files = getTemplates({ hono: false });
    const page = files['src/app/page.tsx']!;

    expect(page).toContain('AQT Stack');
    expect(page).toContain('export default function Home');
  });

  test('hono API route template contains all HTTP method exports', () => {
    const files = getTemplates({ hono: true });
    const route = files['src/app/api/[[...route]]/route.ts']!;

    expect(route).toContain('export const GET');
    expect(route).toContain('export const POST');
    expect(route).toContain('export const PUT');
    expect(route).toContain('export const DELETE');
    expect(route).toContain('export const PATCH');
  });

  test('users route template contains CRUD handlers', () => {
    const files = getTemplates({ hono: true });
    const users = files['src/lib/hono/routes/users.ts']!;

    expect(users).toContain('.get("/users"');
    expect(users).toContain('.post("/users"');
    expect(users).toContain('.get("/users/:id"');
    expect(users).toContain('.delete("/users/:id"');
  });
});
