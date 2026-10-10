CREATE TABLE ${tableOwner}.orders (
    id int IDENTITY(1, 1) PRIMARY KEY,
    customer_id int NOT NULL REFERENCES ${tableOwner}.customers (id),
    total decimal(10, 2) NOT NULL DEFAULT 0
);
