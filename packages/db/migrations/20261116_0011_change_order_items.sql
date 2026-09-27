-- Change-order lines keep their rate-card item (list price and discount ledger survive a re-save).
ALTER TABLE change_order_lines ADD COLUMN rate_card_item_id uuid REFERENCES rate_card_items (id);
CREATE INDEX change_order_lines_item_idx ON change_order_lines (rate_card_item_id);
CREATE INDEX change_order_lines_co_idx ON change_order_lines (change_order_id);
