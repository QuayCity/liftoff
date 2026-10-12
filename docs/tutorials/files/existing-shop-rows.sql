-- A few rows for the production copy (tutorials 4-6). Adopting leaves them untouched.
SET NOCOUNT ON;
INSERT dbo.customers (email, name) VALUES (N'ada@example.com', N'Ada'), (N'linus@example.com', N'Linus'), (N'grace@example.com', N'Grace');
INSERT dbo.products (sku, name, price) VALUES ('ROCKET-1', N'Model rocket', 49.95), ('FUEL-10', N'Fuel pack', 12.50), ('PAD-2', N'Launch pad', 89.00);
INSERT dbo.orders (customer_id, status) VALUES (1, 'shipped'), (2, 'new'), (1, 'new');
INSERT dbo.order_lines (order_id, line_no, product_id, quantity, unit_price) VALUES
    (1, 1, 1, 1, 49.95), (1, 2, 2, 3, 12.50), (2, 1, 3, 1, 89.00), (3, 1, 2, 10, 12.50);
