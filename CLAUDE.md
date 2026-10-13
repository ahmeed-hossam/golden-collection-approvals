# Golden Collection approvals: briefing for Claude

## Who and what
- Owner: Ahmed, commercial finance / FP&A, based in Egypt. Domain: Egyptian FMCG and distribution businesses.
- This repo holds Golden Collection's approval cycle for two departments:
  - **Marketing:** media buyers, marketing executives, designers.
  - **CX & Live Ops (Operations):** CX and live ops agents.

## Source of truth
- `config/approval-rules.yaml`: the agreed rules (4 bands, middle option). Use these numbers in any new work.
- Live request log: Google Sheet "Golden Collection – Approval Requests"
  (https://docs.google.com/spreadsheets/d/1okUZL6QAH3_m2b-KH1RNw52SZK-IQhMwtngyT_1CMeY/edit). Its Settings tab must match the YAML.
- `policy/`: the written policy (Markdown and Word). It still uses the original 5-band matrix and needs updating to the 4-band rules.
- `workbooks/`: approval bands with an approval checker, and worked examples.

## Approval chain (do not change without Ahmed's say-so)
Requester → L1 Senior/Lead → L2 Department Manager → FP&A (second approval) → Procurement where relevant → Strategy Analyst → CEO (Band D only). Accounting processes payments. The CEO Executive Assistant is copied at every stage.
- There is no CFO. Never write "CFO" or "Head of FP&A"; FP&A is the second approver.
- FP&A approves, Accounting pays: keep these separate.

## How Ahmed wants work presented
- FP&A manager style: bps notation, month-on-month comparisons with absolute figures in parentheses, assumption-driven language, and commentary that gives both the analytical assumptions and forward-looking recommendations.
- Deliverables must work immediately with no dependency on ERP or WMS systems.
- Amounts in EGP, including VAT. Spreadsheets use formulas, not typed results, and keep inputs in labelled cells.

## Working rules
- When rules change, update `config/approval-rules.yaml`, the Google Sheet Settings tab and the policy together.
- Use plain commit messages that say what changed in the rules or files.
