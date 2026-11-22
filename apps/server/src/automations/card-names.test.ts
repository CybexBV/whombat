import { describe, expect, it } from 'vitest';
import { nameLookup } from './card-names';

const lookup = (catalogId: string, kind: string) => {
  const found = nameLookup(catalogId, kind);
  if (!found) throw new Error(`no lookup for ${catalogId} ${kind}`);
  return found;
};

describe('how the server reads the names a card shows', () => {
  it('asks each service where it keeps the thing, in the connection’s own account', () => {
    expect(lookup('paperless', 'tag').path('7', {})).toBe('/api/tags/7/');
    expect(lookup('paperless', 'correspondent').path('4', {})).toBe('/api/correspondents/4/');
    expect(lookup('paperless', 'document_type').path('2', {})).toBe('/api/document_types/2/');
    const mb = { administration: '12345' };
    expect(lookup('moneybird', 'contact').path('4242', mb)).toBe('/12345/contacts/4242.json');
    expect(lookup('moneybird', 'ledger_account').path('21', mb)).toBe('/12345/ledger_accounts/21.json');
    expect(lookup('moneybird', 'tax_rate').path('11', mb)).toBe('/12345/tax_rates.json?per_page=100');
    // Without an administration there is nothing to ask.
    expect(lookup('moneybird', 'contact').path('4242', {})).toBeNull();
    expect(lookup('todoist', 'project').path('6Jf8 x', {})).toBe('/api/v1/projects/6Jf8%20x');
    expect(nameLookup('dropbox', 'tag')).toBeNull();
  });

  it('reads the name, says when there is no such thing, and leaves the rest unread', () => {
    const tag = lookup('paperless', 'tag');
    expect(tag.name({ status: 200, json: { id: 7, name: ' Invoices ' } }, '7')).toBe('Invoices');
    expect(tag.name({ status: 404, json: null }, '7')).toBe('missing');
    for (const status of [401, 403, 500]) expect(tag.name({ status, json: null }, '7')).toBeNull();
    expect(tag.name({ status: 200, json: { id: 7 } }, '7')).toBeNull();
    const contact = lookup('moneybird', 'contact');
    expect(contact.name({ status: 200, json: { company_name: 'Acme BV', firstname: 'Ann' } }, '1')).toBe(
      'Acme BV',
    );
    expect(
      contact.name({ status: 200, json: { company_name: '', firstname: 'Ann', lastname: 'Lee' } }, '1'),
    ).toBe('Ann Lee');
    // A list without a path for one: found in it, not in a whole list, or not in a full page (unknown).
    const tax = lookup('moneybird', 'tax_rate');
    const rates = [
      { id: '11', name: '21% btw' },
      { id: '12', name: '9% btw' },
    ];
    expect(tax.name({ status: 200, json: rates }, '12')).toBe('9% btw');
    expect(tax.name({ status: 200, json: rates }, '99')).toBe('missing');
    const page = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `r${i}` }));
    expect(tax.name({ status: 200, json: page }, '999')).toBeNull();
    expect(tax.name({ status: 500, json: null }, '11')).toBeNull();
  });
});
