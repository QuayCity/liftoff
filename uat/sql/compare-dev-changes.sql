-- Changes made on cp_dev outside the migrations: what Compare should find.
CREATE TABLE dbo.suppliers (
    id int IDENTITY(1, 1) PRIMARY KEY,
    name nvarchar(200) NOT NULL,
    country char(2) NULL
);
ALTER TABLE dbo.customers ADD phone nvarchar(30) NULL;
ALTER TABLE dbo.orders ALTER COLUMN total decimal(12, 2) NOT NULL;
CREATE INDEX orders_placed_idx ON dbo.orders (placed_at);
GO
CREATE VIEW dbo.big_orders AS SELECT id, customer_id, total FROM dbo.orders WHERE total > 100;
GO
CREATE FUNCTION dbo.customer_order_count (@customer_id bigint) RETURNS int AS
BEGIN
    RETURN (SELECT COUNT(*) FROM dbo.orders WHERE customer_id = @customer_id);
END;
GO
CREATE PROCEDURE dbo.add_supplier @name nvarchar(200), @country char(2) = NULL AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.suppliers (name, country) VALUES (@name, @country);
END;
