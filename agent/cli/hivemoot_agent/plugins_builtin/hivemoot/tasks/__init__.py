"""Hivemoot delegated-task subsystem.

Claim tasks from ``{claim_url}``, dispatch each as a Job, post
per-task progress / heartbeat / final outcome to
``{execute_base}/<task_id>/execute``.
"""
