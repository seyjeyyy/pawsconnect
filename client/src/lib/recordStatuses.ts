// Listing filters include initial and terminal states, not just staff transitions.
export const recordStatuses:Record<string,string[]>={
 pets:['assessment','available','reserved','adopted','unavailable'],
 orders:['pending_payment','paid','processing','ready_for_shipment','shipped','delivered','cancelled','refunded'],
 adoptions:['submitted','under_review','information_requested','interview','approved','rejected','reserved','awaiting_handover','completed','withdrawn'],
 rescue:['submitted','under_verification','verified','assigned','in_progress','resolved','closed','invalid','duplicate','declined','referred'],
 transport:['submitted','under_review','quoted','confirmed','paid','scheduled','picked_up','in_transit','arrived','completed','declined','cancelled'],
 alternatives:['submitted','under_review','approved','declined','completed','cancelled'],
 volunteers:['submitted','under_review','approved','declined','inactive'],
 donations:['pending','paid','pledged','received','cancelled'],
 payments:['pending','paid','failed','expired','refunded','paid_requires_review'],
};
