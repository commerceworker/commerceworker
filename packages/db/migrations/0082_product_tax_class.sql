-- A product's tax class (`reduced`, `gift-card`), kept current by the catalog like its name and
-- price: the tax node rates a line by it. Null is the standard rate, as every row was taxed before.
ALTER TABLE products ADD COLUMN tax_class TEXT;
