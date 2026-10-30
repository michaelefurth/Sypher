# Email signature

- `signature.html`: the full signature, for new messages.
- `signature-reply.html`: the compact version, for replies and forwards.

Both are table-based with inline styles so they hold up in Gmail, Outlook and Apple Mail. The images (`assets/img/email/`) load from https://sypher.solutions, so deploy the site before using the signature. To add a phone number, copy the email line in `signature.html` and add a `tel:` link beside it.
