-- An existing shop database that was never under a migration tool (tutorials 4-6).
-- Run it on an empty database: four tables, a view, a function, a procedure and a trigger.
CREATE TABLE dbo.customers (
    id int IDENTITY(1, 1) NOT NULL CONSTRAINT pk_customers PRIMARY KEY,
    email nvarchar(320) NOT NULL CONSTRAINT uq_customers_email UNIQUE,
    name nvarchar(200) NOT NULL,
    created_at datetime2 NOT NULL CONSTRAINT df_customers_created DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.products (
    id int IDENTITY(1, 1) NOT NULL CONSTRAINT pk_products PRIMARY KEY,
    sku varchar(20) NOT NULL CONSTRAINT uq_products_sku UNIQUE,
    name nvarchar(100) NOT NULL,
    price decimal(10, 2) NOT NULL CONSTRAINT ck_products_price CHECK (price >= 0)
);

CREATE TABLE dbo.orders (
    id int IDENTITY(1, 1) NOT NULL CONSTRAINT pk_orders PRIMARY KEY,
    customer_id int NOT NULL CONSTRAINT fk_orders_customer REFERENCES dbo.customers (id),
    placed_at datetime2 NOT NULL CONSTRAINT df_orders_placed DEFAULT SYSUTCDATETIME(),
    status varchar(10) NOT NULL CONSTRAINT df_orders_status DEFAULT 'new',
    updated_at datetime2 NULL
);

CREATE INDEX ix_orders_customer ON dbo.orders (customer_id, placed_at);

CREATE TABLE dbo.order_lines (
    order_id int NOT NULL CONSTRAINT fk_lines_order REFERENCES dbo.orders (id),
    line_no smallint NOT NULL,
    product_id int NOT NULL CONSTRAINT fk_lines_product REFERENCES dbo.products (id),
    quantity int NOT NULL,
    unit_price decimal(10, 2) NOT NULL,
    CONSTRAINT pk_order_lines PRIMARY KEY (order_id, line_no)
);
GO

CREATE VIEW dbo.order_summary AS
SELECT o.id, o.customer_id, o.status, SUM(l.quantity * l.unit_price) AS total
FROM dbo.orders o
JOIN dbo.order_lines l ON l.order_id = o.id
GROUP BY o.id, o.customer_id, o.status;
GO

CREATE FUNCTION dbo.order_total (@order_id int) RETURNS decimal(12, 2) AS
BEGIN
    RETURN (SELECT SUM(quantity * unit_price) FROM dbo.order_lines WHERE order_id = @order_id);
END;
GO

CREATE PROCEDURE dbo.orders_for_customer @customer_id int AS
BEGIN
    SET NOCOUNT ON;
    SELECT id, placed_at, status, dbo.order_total(id) AS total FROM dbo.orders WHERE customer_id = @customer_id;
END;
GO

CREATE TRIGGER dbo.orders_touch ON dbo.orders AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    UPDATE o SET updated_at = SYSUTCDATETIME() FROM dbo.orders o JOIN inserted i ON i.id = o.id;
END;
