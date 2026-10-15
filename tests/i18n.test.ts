import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { ar } from '../src/shared/i18n/ar';

/** Every literal passed to the translation functions: t() and tk() in the window, tm() in the main process. */
function interfaceTexts(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'i18n') walk(p); continue; }
      if (!/\.tsx?$/.test(name)) continue;
      const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ['t', 'tk', 'tm'].includes(n.expression.getText(sf))) {
          const a = n.arguments[0];
          if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) out.set(a.text, `${p}:${sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  };
  walk(join(__dirname, '../src/renderer'));
  walk(join(__dirname, '../src/main'));
  return out;
}

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe('Arabic interface', () => {
  const texts = interfaceTexts();

  it('finds the interface texts', () => {
    expect(texts.size).toBeGreaterThan(500);
  });

  it('has an Arabic text for every interface text', () => {
    const missing = [...texts].filter(([en]) => !(en in ar)).map(([en, at]) => `${at}  ${JSON.stringify(en)}`);
    expect(missing).toEqual([]);
  });

  it('keeps every placeholder', () => {
    const broken = Object.entries(ar).filter(([en, text]: [string, string]) => placeholders(en).join() !== placeholders(text).join()).map(([en]) => en);
    expect(broken).toEqual([]);
  });

  it('has no fragments left of sentences split around a value', () => {
    // A text that starts or ends inside a sentence ("of", "Waiting for “") cannot be translated well.
    const fragments = [...texts.keys()].filter((en) => /[“(]$|^[”)]|\s(of|for|to|the|in)$/.test(en));
    expect(fragments).toEqual([]);
  });
});
