-- Closes the check-then-insert race in the authorize step's adoption of an intent made elsewhere
-- (`adoptProblem` looks for another order's row, then inserts: two orders adopting one PaymentIntent
-- at once could both pass), and gives Stripe's hourly event reconciliation (docs/operations.md,
-- "Stripe reconciliation") somewhere to keep its place.
--
-- A row that claims a processor id is an authorization that wasn't declined, or a refund. A capture
-- and a charge name their authorization's own intent and a decline names the intent it refused, so
-- they stay out of the index. The code already deployed never inserts a second claim on purpose; if a
-- race did, the refused insert makes its step throw and retry (it reads the row it didn't insert),
-- which is no worse than the two claims it would have made.
--
-- Before the index, a claim that is already doubled (nothing deployed has any) is made safe rather
-- than deleted. Of two authorizations on one intent the one that holds money keeps it (captured, then
-- authorized, then voided, then verified; the older on a tie) and the other is marked declined, its
-- `ref` left alone unless empty; a loser that is itself `captured` keeps its status and `ref` and only
-- loses its processor id, so no captured money is rewritten. The newer of two refunds loses its
-- processor id and keeps its amount.
UPDATE payments SET
  status = CASE WHEN status = 'captured' THEN status ELSE 'declined' END,
  external_id = CASE WHEN status = 'captured' THEN NULL ELSE external_id END,
  ref = CASE WHEN status = 'captured' THEN ref
             ELSE COALESCE(ref, 'Duplicate claim on PaymentIntent (migration 0080)') END
WHERE external_id IS NOT NULL AND kind LIKE 'authorization:%' AND status <> 'declined'
  AND EXISTS (
    SELECT 1 FROM payments o
    WHERE o.external_id = payments.external_id AND o.kind LIKE 'authorization:%'
      AND o.status <> 'declined' AND o.id <> payments.id
      AND (
        (CASE o.status WHEN 'captured' THEN 0 WHEN 'authorized' THEN 1 WHEN 'voided' THEN 2 ELSE 3 END)
          < (CASE payments.status WHEN 'captured' THEN 0 WHEN 'authorized' THEN 1 WHEN 'voided' THEN 2 ELSE 3 END)
        OR (
          (CASE o.status WHEN 'captured' THEN 0 WHEN 'authorized' THEN 1 WHEN 'voided' THEN 2 ELSE 3 END)
            = (CASE payments.status WHEN 'captured' THEN 0 WHEN 'authorized' THEN 1 WHEN 'voided' THEN 2 ELSE 3 END)
          AND (o.created_at < payments.created_at OR (o.created_at = payments.created_at AND o.id < payments.id))
        )
      )
  );
UPDATE payments SET external_id = NULL
WHERE external_id IS NOT NULL AND kind = 'refund'
  AND EXISTS (
    SELECT 1 FROM payments o
    WHERE o.external_id = payments.external_id AND o.kind = 'refund'
      AND (o.created_at < payments.created_at OR (o.created_at = payments.created_at AND o.id < payments.id))
  );
CREATE UNIQUE INDEX payments_external_claim ON payments(external_id)
  WHERE external_id IS NOT NULL
    AND (kind = 'refund' OR (kind LIKE 'authorization:%' AND status <> 'declined'));

-- Where the reconciliation left off, per provider: `cursor` is the `created` (Unix seconds) of the
-- oldest Stripe event it hasn't finished with. It only moves forward.
CREATE TABLE payment_cursors (
  provider TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
