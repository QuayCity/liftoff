-- The same tables and rows in dc_source, dc_target and dc_prod; data-target-changes.sql then
-- changes known rows in target and prod.
SET NOCOUNT ON;
CREATE TABLE dbo.customers (
    id int NOT NULL PRIMARY KEY,
    name nvarchar(100) NOT NULL,
    email nvarchar(200) NULL,
    city nvarchar(50) NULL,
    balance decimal(10, 2) NOT NULL,
    notes nvarchar(max) NULL
);
CREATE TABLE dbo.products (
    id int IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    sku varchar(20) NOT NULL UNIQUE,
    name nvarchar(100) NOT NULL,
    price decimal(10, 2) NOT NULL
);
CREATE TABLE dbo.order_lines (
    order_id int NOT NULL,
    line_no smallint NOT NULL,
    quantity int NOT NULL,
    unit_price decimal(10, 2) NOT NULL,
    CONSTRAINT pk_order_lines PRIMARY KEY (order_id, line_no)
);
CREATE TABLE dbo.events (
    id bigint NOT NULL PRIMARY KEY,
    kind varchar(20) NOT NULL,
    payload nvarchar(100) NULL,
    at datetime2 NOT NULL
);
-- No key: data compare cannot match its rows, so it is skipped.
CREATE TABLE dbo.audit_log (
    at datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
    message nvarchar(200) NULL
);
GO
SET NOCOUNT ON;
WITH n AS (SELECT TOP (200000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS i FROM sys.all_objects a CROSS JOIN sys.all_objects b)
SELECT i INTO #n FROM n;

INSERT dbo.customers (id, name, email, city, balance, notes)
SELECT i, CONCAT(N'Customer ', i),
       CASE WHEN i % 97 = 0 THEN NULL ELSE CONCAT(N'c', i, N'@example.com') END,
       CHOOSE(i % 5 + 1, N'Oslo', N'Utrecht', N'Zürich', N'Kraków', NULL),
       CAST(i % 1000 AS decimal(10, 2)) + 0.5,
       CASE WHEN i % 10 = 0 THEN N'Zoë ✓ 日本' END
FROM #n WHERE i <= 10000;

INSERT dbo.products (sku, name, price)
SELECT CONCAT('SKU-', i), CONCAT(N'Product ', i), i * 1.25 FROM #n WHERE i <= 50 ORDER BY i;

INSERT dbo.order_lines (order_id, line_no, quantity, unit_price)
SELECT (i - 1) / 5 + 1, (i - 1) % 5 + 1, i % 9 + 1, (i % 40) * 1.5 FROM #n WHERE i <= 5000;

INSERT dbo.events (id, kind, payload, at)
SELECT i, CONCAT('kind', i % 7), CONCAT(N'payload ', i), DATEADD(second, i, '2026-01-01') FROM #n;

INSERT dbo.audit_log (message) VALUES (N'created');
DROP TABLE #n;
