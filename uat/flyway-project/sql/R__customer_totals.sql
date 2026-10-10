CREATE OR ALTER VIEW ${tableOwner}.customer_totals AS
SELECT c.id, c.email, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS spent
FROM ${tableOwner}.customers c
LEFT JOIN ${tableOwner}.orders o ON o.customer_id = c.id
GROUP BY c.id, c.email;
