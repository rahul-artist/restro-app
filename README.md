# Restaurant QR POS – Complete Application

This version upgrades the basic QR menu into a restaurant operations application.

## Included

- Table-specific QR codes
- Mobile customer menu
- Food images on menu items
- Item customization / add-ons
- Cart and special instructions
- Multiple orders on the same table session
- Customer order -> waiter/kitchen live polling dashboard
- Order status workflow: NEW -> ACCEPTED -> PREPARING -> READY -> SERVED
- Table session lifecycle
- Checkout closes the current table session
- After payment, the same table QR automatically creates a new session
- GST calculation: CGST + SGST for same-state, IGST for inter-state place of supply
- Configurable GST rates per menu item
- GST invoice with print / Save as PDF
- Custom bill items
- Discounts
- Payment modes: Cash / UPI / Card / Other
- Owner dashboard
- Sales / GST / payment / top-item reports
- Expense capture
- Audit log
- CA/accountant CSV exports
- Sales register
- GST summary
- Expense register
- Audit export
- Business/GSTIN settings
- SQLite database with WAL mode
- Dockerfile + docker-compose
- Responsive mobile UI

## Demo accounts

Owner:
admin / ChangeMe123!

Manager:
manager / Manager123!

Waiter:
waiter / Waiter123!

Cashier:
cashier / Cashier123!

Kitchen:
kitchen / Kitchen123!

CA:
ca / CA123456!

CHANGE THESE PASSWORDS before production.

## Windows 11

Install Node.js 22 LTS.

PowerShell:

    cd D:\Target\restaurant-qr-pos
    npm install
    copy .env.example .env
    npm start

Open:

    http://localhost:3000/admin
    http://localhost:3000/staff

Customer menu normally opens from a table QR.

## Generate table QR

1. Login to Admin.
2. Open Tables & QR Codes.
3. Each table has its own QR.
4. Download and print it.

The QR contains a URL such as:

    http://YOUR-SERVER:3000/menu.html?table=TABLE_TOKEN

## Test using a phone on the same Wi-Fi

`localhost` only works on the computer itself.

Find your computer IP:

    ipconfig

Example:

    192.168.1.25

Set:

    APP_URL=http://192.168.1.25:3000

Restart the server and regenerate/download the QR.

Allow Node.js / TCP 3000 through Windows Firewall if necessary.

## Production

Use a public HTTPS domain, strong passwords, a persistent database backup strategy, secure session configuration, HTTPS, reverse proxy, proper user password hashing, and a production-grade deployment.

For actual GST/ITR compliance, have the restaurant's CA/tax professional review the tax configuration and reports. The application calculates configured taxes and organizes records; it does not replace government filing/verification or professional tax advice.

## Backup

The database is:

    data/restaurant.db

Back it up regularly.

## Architecture

Browser
  -> Express API
  -> SQLite
  -> Customer / Staff / Admin UI

Main business entities:

users
restaurant_tables
categories
menu_items
item_customizations
table_sessions
orders
order_items
payments
invoices
invoice_items
custom_bill_items
expenses
audit_logs
settings

## Important production hardening

This package is a complete runnable business MVP/reference implementation. Before using it for a live restaurant, add:
- bcrypt/Argon2 password hashing
- HTTPS
- CSRF protection where applicable
- secure cookie settings
- rate limiting
- database backups
- role-level permission review
- GST/CA review of tax rules
- official payment gateway integration if online payment is required
- official government GST integrations only where legally/technically available
- monitoring and error tracking
