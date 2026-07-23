# Restrict production execution to explicit read-only runs

Production execution is denied by default and requires an explicit read-only opt-in against a declared **Environment Profile**. Even with opt-in, the runtime executes only steps whose **Side-effect Class** is `none`, performs no test-data operations, and captures evidence only when the configured redaction policy can protect real data; reversible, external, and destructive steps remain prohibited in the MVP.
