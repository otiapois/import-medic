import { useId, useLayoutEffect, useRef, useState } from 'react';
import { bookkeeperRulePackSchema } from '../../../core/accounting/categorization-rules';
import type { BookkeeperRule, BookkeeperRulePack } from '../../../core/accounting/categorization-rules';

const MATCH_LABELS = { contains: 'Contains', 'starts-with': 'Starts with', exact: 'Exact' } as const;
const DIRECTION_LABELS = { any: 'Any direction', debit: 'Debit', credit: 'Credit' } as const;
const MAX_RULES = 250;
const TEXT_FIELDS = [
  { key: 'id', label: 'Rule ID', maxLength: 120 },
  { key: 'label', label: 'Rule label', maxLength: 120 },
  { key: 'pattern', label: 'Description / Payee pattern', maxLength: 256 },
  { key: 'accountCode', label: 'Account code', maxLength: 120 },
  { key: 'accountName', label: 'Account name', maxLength: 120 },
  { key: 'taxCode', label: 'Tax code', maxLength: 120 },
] as const;
const NUMBER_FIELDS = [
  { key: 'minAmountCents', label: 'Minimum absolute amount (cents)' },
  { key: 'maxAmountCents', label: 'Maximum absolute amount (cents)' },
  { key: 'inclusiveTaxRateBps', label: 'Inclusive tax rate (bps)' },
] as const;

type NumberField = (typeof NUMBER_FIELDS)[number]['key'];
type RuleDraft = Omit<BookkeeperRule, NumberField> & Record<NumberField, string>;

export function optionalWholeNumber(value: string): number | undefined {
  const text = value.trim();
  return text ? (/^\d+$/.test(text) ? Number(text) : NaN) : undefined;
}

export function RuleEditor({ pack, onChange }: { pack: BookkeeperRulePack; onChange: (value: BookkeeperRulePack) => void }) {
  const id = useId();
  const { rules } = pack;
  const [editing, setEditing] = useState<{ originalId?: string; draft: RuleDraft }>();
  const [errors, setErrors] = useState<string[]>([]);
  const [orderMessage, setOrderMessage] = useState('');
  const focus = useRef<string | undefined>(undefined);
  const addId = `${id}-add`;
  const labelId = `${id}-label`;

  useLayoutEffect(() => {
    if (focus.current) {
      document.getElementById(focus.current)?.focus();
      focus.current = undefined;
    }
  });

  function begin(original?: BookkeeperRule) {
    let generated = '';
    if (!original) {
      const ids = new Set(rules.map(({ id }) => id));
      let index = rules.length + 1;
      while (ids.has(`rule-${index}`)) index += 1;
      generated = `rule-${index}`;
    }
    setEditing({ originalId: original?.id, draft: {
      id: original?.id ?? generated,
      label: original?.label ?? '',
      pattern: original?.pattern ?? '',
      matchType: original?.matchType ?? 'contains',
      direction: original?.direction ?? 'any',
      accountCode: original?.accountCode ?? '',
      accountName: original?.accountName ?? '',
      taxCode: original?.taxCode ?? '',
      minAmountCents: original?.minAmountCents?.toString() ?? '',
      maxAmountCents: original?.maxAmountCents?.toString() ?? '',
      inclusiveTaxRateBps: original?.inclusiveTaxRateBps?.toString() ?? '',
    } });
    setErrors([]);
    focus.current = labelId;
  }

  function changeDraft<Key extends keyof RuleDraft>(key: Key, value: RuleDraft[Key]) {
    setEditing((previous) => previous && { ...previous, draft: { ...previous.draft, [key]: value } });
  }

  function close(nextFocus: string) {
    focus.current = nextFocus;
    setEditing(undefined);
    setErrors([]);
  }

  function save(draft: RuleDraft, originalId?: string) {
    const { minAmountCents, maxAmountCents, inclusiveTaxRateBps, ...text } = draft;
    const min = optionalWholeNumber(minAmountCents);
    const max = optionalWholeNumber(maxAmountCents);
    const rate = optionalWholeNumber(inclusiveTaxRateBps);
    const rule: BookkeeperRule = {
      ...text,
      ...(min === undefined ? {} : { minAmountCents: min }),
      ...(max === undefined ? {} : { maxAmountCents: max }),
      ...(rate === undefined ? {} : { inclusiveTaxRateBps: rate }),
    };
    const nextRules = originalId ? rules.map((item) => item.id === originalId ? rule : item) : [...rules, rule];
    const validated = bookkeeperRulePackSchema.safeParse({ ...pack, rules: nextRules });
    if (!validated.success) {
      setErrors(validated.error.issues.map(({ path, message }) => {
        const key = path.at(-1);
        const field = [...TEXT_FIELDS, ...NUMBER_FIELDS].find(({ key: name }) => name === key);
        return field ? `${field.label} · ${message}` : message;
      }));
      return;
    }
    onChange(validated.data);
    setOrderMessage(`${draft.label.trim()} ${originalId ? 'updated' : 'added'}.`);
    close(`${id}-edit-${draft.id.trim()}`);
  }

  function move(index: number, offset: -1 | 1, buttonId: string) {
    const destination = index + offset;
    if (destination < 0 || destination >= rules.length) return;
    const reordered = [...rules];
    const [rule] = reordered.splice(index, 1);
    reordered.splice(destination, 0, rule);
    focus.current = buttonId;
    onChange({ ...pack, rules: reordered });
    setOrderMessage(`${rule.label} moved to position ${destination + 1} of ${reordered.length}.`);
  }

  return (
    <div className="categorization-rule-editor">
      <div className="categorization-heading-row">
        <h3>Rules in priority order</h3>
        <button id={addId} type="button" className="button button-secondary button-small"
          disabled={Boolean(editing) || rules.length >= MAX_RULES} onClick={() => begin()}>Add Rule</button>
      </div>
      {rules.length ? <ol className="categorization-rule-list" aria-label="Rule priority order">
        {rules.map((rule, index) => {
          const editId = `${id}-edit-${rule.id}`;
          const upId = `${id}-up-${rule.id}`;
          const downId = `${id}-down-${rule.id}`;
          const pattern = `${MATCH_LABELS[rule.matchType]} “${rule.pattern}”`;
          return (
            <li key={rule.id}>
              <div className="categorization-rule">
                <div>
                  <strong>{rule.label}</strong> <span className="result-format">· {rule.id}</span>
                  <p className="field-help">{pattern} · {DIRECTION_LABELS[rule.direction]}<br />{rule.accountCode} · {rule.accountName} · {rule.taxCode}
                    {rule.inclusiveTaxRateBps === undefined ? '' : ` · ${rule.inclusiveTaxRateBps} bps`}</p>
                </div>
                <div className="categorization-buttons">
                  <button id={editId} className="button button-secondary button-small" type="button" aria-label={`Edit ${rule.label}`}
                    disabled={Boolean(editing)} onClick={() => begin(rule)}>Edit</button>
                  <button id={upId} className="button button-secondary button-small" type="button" aria-label={`Move ${rule.label} up`}
                    aria-disabled={index === 0 || Boolean(editing)} onClick={() => { if (!editing) move(index, -1, upId); }}>↑</button>
                  <button id={downId} className="button button-secondary button-small" type="button" aria-label={`Move ${rule.label} down`}
                    aria-disabled={index === rules.length - 1 || Boolean(editing)} onClick={() => { if (!editing) move(index, 1, downId); }}>↓</button>
                  <button className="button button-secondary button-small" type="button" aria-label={`Delete ${rule.label}`}
                    disabled={Boolean(editing)} onClick={() => {
                      const sibling = rules[index + 1] ?? rules[index - 1];
                      focus.current = sibling ? `${id}-edit-${sibling.id}` : addId;
                      onChange({ ...pack, rules: rules.filter((item) => item.id !== rule.id) });
                      setOrderMessage(`${rule.label} deleted.`);
                    }}>Delete</button>
                </div>
              </div>
            </li>
          );
        })}
      </ol> : <p className="field-help">Add a rule or load a saved rule pack.</p>}
      <p className="sr-only" role="status">{orderMessage}</p>
      {editing ? (
        <form className="categorization-rule-form" onSubmit={(event) => {
          event.preventDefault();
          save(editing.draft, editing.originalId);
        }}>
          <h4>{editing.originalId ? 'Edit rule' : 'New rule'}</h4>
          <div className="categorization-fields">
            {TEXT_FIELDS.map(({ key, label, maxLength }) => (
              <label key={key}>{label}
                <input id={key === 'label' ? labelId : undefined} required maxLength={maxLength} value={editing.draft[key]}
                  onChange={(event) => changeDraft(key, event.currentTarget.value)} />
              </label>
            ))}
            <label>Match type
              <select value={editing.draft.matchType} onChange={(event) => changeDraft('matchType', event.currentTarget.value as BookkeeperRule['matchType'])}>
                {Object.entries(MATCH_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>Direction
              <select value={editing.draft.direction} onChange={(event) => changeDraft('direction', event.currentTarget.value as BookkeeperRule['direction'])}>
                {Object.entries(DIRECTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {NUMBER_FIELDS.map(({ key, label }) => (
              <label key={key}>{label}
                <input inputMode="numeric" placeholder="Optional" value={editing.draft[key]} onChange={(event) => changeDraft(key, event.currentTarget.value)} />
              </label>
            ))}
          </div>
          <p className="field-help">Enter whole cents for limits. 500 basis points equals 5%.</p>
          {errors.length ? <ul className="recipe-diagnostics" role="alert">{errors.map((message, index) => <li key={index}>{message}</li>)}</ul> : null}
          <div className="categorization-buttons">
            <button className="button button-primary button-small" type="submit">Save Rule</button>
            <button className="button button-secondary button-small" type="button" onClick={() => close(editing.originalId ? `${id}-edit-${editing.originalId}` : addId)}>Cancel</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
