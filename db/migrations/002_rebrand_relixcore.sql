-- Company name is now RelixCore.
UPDATE settings SET company_name = 'RelixCore' WHERE id = 1;
ALTER TABLE settings ALTER COLUMN company_name SET DEFAULT 'RelixCore';
