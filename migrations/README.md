# Database migrations

Apply SQL files in numeric order to the existing Neon database using a migration connection. Record the applied migration number in the deployment/change record. This migration creates tables only when absent and does not drop or reset existing objects.

Rollback means reverting the application code to local-only mode. Leave imported tables and rows intact. Do not drop tables as part of an application rollback. Any future schema rollback must be a separately reviewed, data-preserving migration.
