return {
  server = "http://127.0.0.1:3000",

  -- Identifies this AE2 network to the server AND is your website login.
  -- Leave blank and run 'install-connector' to have a strong one generated,
  -- or set your own random string of at least 16 characters.
  api_key = "",

  -- Display name shown on the website.
  name = "base",

  poll_interval = 10,
  tunnel_timeout = 8,
}
