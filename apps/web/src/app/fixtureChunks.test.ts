import { describe, expect, it } from 'vitest';
import { fixtureChunks } from '../../fixture-chunks';

const chunk = (fileName: string, imports: string[] = [], isEntry = false) => ({ fileName, imports, isEntry });

describe('where a production build’s mock world may be (look-around.md)', () => {
  const chunks = [
    chunk('index.js', ['react.js', 'app.js'], true),
    chunk('react.js'),
    chunk('app.js', ['shared.js']),
    chunk('shared.js'),
    // Imported only by `import()`: the demo and the world it loads.
    chunk('DemoWorld.js', ['app.js', 'world.js']),
    chunk('world.js'),
  ];

  it('the box’s page: nowhere', () => {
    expect(fixtureChunks(chunks, false).map((c) => c.fileName)).toEqual(chunks.map((c) => c.fileName));
  });

  it('the hosted app: not in what the page loads by itself, so only the demo’s own chunks may hold it', () => {
    expect(fixtureChunks(chunks, true).map((c) => c.fileName)).toEqual([
      'index.js',
      'react.js',
      'app.js',
      'shared.js',
    ]);
  });
});
