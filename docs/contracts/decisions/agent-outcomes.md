# Agent outcomes — contracts 0.45.0–0.45.1

- Add Microsoft as a connector provider with explicit selection, provider-bound OAuth and approval identity. Mail, calendar, files and contacts are supported; native Word/Excel editing is not advertised.
- Add bounded binary/attachment operations and attachment hashes for send approval.
- Add optional preference evidence and expiry, stable topic corrections and Unicode tokenization.
- Add observed completion evidence, provider-neutral skill outcomes and declared skill prerequisites.
- Session API level 31; optional fields preserve previous readers. New endpoint secrets never produce replay input digests.

- 0.45.1: Every approval surface derives the selected provider label and the complete attachment list from the approved action. Attachments must be visible before consent, not only bound by a server digest.
