-- A Flyway-style history table, as its public documentation describes it, with the four scripts
-- the flyway scenario runs. reset.ps1 deletes the rows a database has not run.
SET NOCOUNT ON;
CREATE TABLE dbo.flyway_schema_history (
    installed_rank int NOT NULL CONSTRAINT flyway_schema_history_pk PRIMARY KEY,
    version nvarchar(50) NULL,
    description nvarchar(200) NULL,
    type nvarchar(20) NOT NULL,
    script nvarchar(1000) NOT NULL,
    checksum int NULL,
    installed_by nvarchar(100) NOT NULL,
    installed_on datetime NOT NULL DEFAULT GETDATE(),
    execution_time int NOT NULL,
    success bit NOT NULL
);
INSERT dbo.flyway_schema_history (installed_rank, version, description, type, script, checksum, installed_by, execution_time, success) VALUES
    (1, '1', 'create customers', 'SQL', 'V1__create_customers.sql', NULL, 'sa', 12, 1),
    (2, '2', 'create orders', 'SQL', 'V2__create_orders.sql', NULL, 'sa', 9, 1),
    (3, '3', 'orders index', 'SQL', 'V3__orders_index.sql', NULL, 'sa', 4, 1),
    (4, NULL, 'customer totals', 'SQL', 'R__customer_totals.sql', NULL, 'sa', 3, 1);
