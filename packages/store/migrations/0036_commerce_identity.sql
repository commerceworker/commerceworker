-- An explicit migration link; never infer identity ownership from an email address.
ALTER TABLE users ADD COLUMN commerce_subject TEXT;
CREATE UNIQUE INDEX users_commerce_subject ON users(commerce_subject)
  WHERE commerce_subject IS NOT NULL;
