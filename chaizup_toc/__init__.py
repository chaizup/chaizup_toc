"""
Chaizup TOC — Theory of Constraints Buffer Management for ERPNext
=================================================================
Replaces default Auto Material Request with TOC Buffer Penetration logic.
On install: automatically disables ERPNext default auto reorder scheduler.

Core Formulas:
  F1: Target Buffer   = ADU × RLT × VF
  F2: IP (FG)        = On-Hand + WIP − Backorders
  F2: IP (RM/PM)     = On-Hand + On-Order − Committed
  F3: BP%            = (Target − IP) ÷ Target × 100
  F4: Order Qty      = Target − IP
  F5: T/CU           = (Price − RM − PM) ÷ Constraint Minutes
"""

__version__ = "1.0.0"
