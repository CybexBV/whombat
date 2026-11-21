/** Where Whombat looks for a connection's own logo (connection-looks.md): its MCP server's icons and its website's. */
import { describe, expect, it } from 'vitest';
import { mcpIconAddresses, siteOf, svgIconLinks } from './find';

describe('the site a host belongs to', () => {
  it('keeps the last two labels, three for a country’s second level', () => {
    expect(siteOf('mcp.linear.app')).toBe('linear.app');
    expect(siteOf('api.openweathermap.org')).toBe('openweathermap.org');
    expect(siteOf('linear.app')).toBe('linear.app');
    expect(siteOf('api.example.co.uk')).toBe('example.co.uk');
  });
});

describe('an MCP server’s own icons', () => {
  const server = 'https://mcp.linear.app/mcp';
  it('takes SVGs on the server’s own site or inline, light ones first', () => {
    const info = {
      name: 'linear',
      icons: [
        { src: 'https://linear.app/static/dark.svg', mimeType: 'image/svg+xml', theme: 'dark' },
        { src: 'https://linear.app/static/light.svg', mimeType: 'image/svg+xml', theme: 'light' },
        { src: 'https://linear.app/icon.png', mimeType: 'image/png' },
        { src: 'https://tracker.example.com/logo.svg', mimeType: 'image/svg+xml' },
        { src: 'http://linear.app/plain.svg' },
        { src: 'data:image/svg+xml;base64,PHN2Zy8+' },
      ],
    };
    expect(mcpIconAddresses(info, server)).toEqual([
      'https://linear.app/static/light.svg',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'https://linear.app/static/dark.svg',
    ]);
  });

  it('is empty without icons', () => {
    expect(mcpIconAddresses(null, server)).toEqual([]);
    expect(mcpIconAddresses({ icons: 'no' }, server)).toEqual([]);
  });
});

describe('a website’s SVG icon', () => {
  it('finds icon links that are SVGs, as full addresses', () => {
    const html = `<head>
      <link rel="icon" href="/favicon.ico">
      <link rel="icon" type="image/svg+xml" href="/brand/icon.svg">
      <link href="https://cdn.example.com/m.svg" rel="mask-icon" color="#000">
      <link rel="stylesheet" href="/style.svg">
    </head>`;
    expect(svgIconLinks(html, 'https://example.com/')).toEqual([
      'https://example.com/brand/icon.svg',
      'https://cdn.example.com/m.svg',
    ]);
  });
});
