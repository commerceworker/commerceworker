-- Approvals decided by votes (docs/b2b.md, S5). An Approval step names its approvers (`staff:<role>`,
-- `company:<role>`, `team:<id>` or `members:<ids>`) and a mode (any, all, majority, quorum), and the
-- OrderAgent sends the Workflow its one decision event only once the votes decide it. Each vote is
-- one row, unique per approval and voter, so a replayed or retried vote changes nothing. A voter is
-- a staff principal (`staff`, by their id) or a company member (`member`); until buyers can sign in
-- (D3) staff record a member's vote, and `on_behalf_by` is the staff principal who did.
-- The approval's own row gains who may vote, resolved when the wait opened: `approvers` and `mode`
-- as the flow wrote them, the `company_id` whose members vote, `required` (the approvals that
-- decide it) and `eligible`, a JSON array of the voters' ids (null when any staff with the role
-- may decide, which is every approval that existed before). The defaults are exactly what every
-- existing approval was: any one staff approver. Every column is new and defaulted or nullable,
-- so the code already deployed, which never names them, keeps working.
CREATE TABLE approval_votes (
  approval_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  voter_kind TEXT NOT NULL,
  on_behalf_by TEXT,
  decision TEXT NOT NULL,
  note TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (approval_id, voter_id)
);

ALTER TABLE approvals ADD COLUMN company_id TEXT;
ALTER TABLE approvals ADD COLUMN approvers TEXT NOT NULL DEFAULT 'staff:approver';
ALTER TABLE approvals ADD COLUMN mode TEXT NOT NULL DEFAULT 'any';
ALTER TABLE approvals ADD COLUMN required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE approvals ADD COLUMN eligible TEXT;

CREATE INDEX approvals_company ON approvals (company_id, status, requested_at)
  WHERE company_id IS NOT NULL;
