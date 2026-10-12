-- What makes dc_target (and dc_prod) differ from dc_source. The expected counts per table:
--   dbo.customers    only in source 30, only in target 20, different 25
--   dbo.products     only in source 1,  only in target 1,  different 3
--   dbo.order_lines  only in source 2,  only in target 1,  different 5
--   dbo.events       only in source 0,  only in target 0,  different 3   (of 200,000 rows)
--   dbo.page_views   only in source 13, only in target 8  (no key: whole rows; 10 deleted, 5 extra copies, 3 changed)
--   dbo.audit_log    only in source 1,  only in target 2   (no key; its "created" row has a different time on each side)
SET NOCOUNT ON;
DELETE dbo.customers WHERE id BETWEEN 1 AND 30;
INSERT dbo.customers (id, name, email, city, balance)
SELECT 20000 + n, CONCAT(N'Extra ', n), NULL, N'Gent', 0 FROM (VALUES (1),(2),(3),(4),(5),(6),(7),(8),(9),(10),(11),(12),(13),(14),(15),(16),(17),(18),(19),(20)) v(n);
UPDATE dbo.customers SET city = N'Amsterdam' WHERE id BETWEEN 101 AND 110;      -- a value changed
UPDATE dbo.customers SET email = NULL WHERE id BETWEEN 111 AND 115;             -- value to NULL
UPDATE dbo.customers SET balance = balance + 1 WHERE id BETWEEN 116 AND 120;     -- a number
UPDATE dbo.customers SET name = CONCAT(N'Ünïcödé ', id) WHERE id BETWEEN 121 AND 125;

DELETE dbo.products WHERE id = 50;
UPDATE dbo.products SET price = price + 10 WHERE id IN (1, 2, 3);
SET IDENTITY_INSERT dbo.products ON;
INSERT dbo.products (id, sku, name, price) VALUES (100, 'SKU-TARGET', N'Only in target', 1);
SET IDENTITY_INSERT dbo.products OFF;

DELETE dbo.order_lines WHERE order_id = 1 AND line_no IN (1, 2);
UPDATE dbo.order_lines SET quantity = quantity + 100 WHERE order_id = 2;
INSERT dbo.order_lines (order_id, line_no, quantity, unit_price) VALUES (1001, 1, 1, 1);

UPDATE dbo.events SET payload = N'changed' WHERE id IN (5, 100000, 199999);

-- A heap: 10 rows gone, 5 rows twice (an extra copy each), 3 rows changed (a changed row is one
-- only in the source and one only in the target: without a key nothing says it is the same row).
DELETE dbo.page_views WHERE at BETWEEN '2026-01-01 01:01' AND '2026-01-01 01:10';
INSERT dbo.page_views SELECT TOP (5) * FROM dbo.page_views WHERE at >= '2026-01-02' ORDER BY at;
UPDATE dbo.page_views SET path = N'/checkout' WHERE at IN ('2026-01-03 00:00', '2026-01-03 00:01', '2026-01-03 00:02');

INSERT dbo.audit_log (message) VALUES (N'only here');
