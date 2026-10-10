CREATE TABLE ${tableOwner}.customers (
    id int IDENTITY(1, 1) PRIMARY KEY,
    email nvarchar(320) NOT NULL UNIQUE,
    created_at datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
