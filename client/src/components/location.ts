export type LocationValue = { address: string; province: string; city: string; barangay: string; latitude?: number; longitude?: number };
export const emptyLocation = (): LocationValue => ({ address: '', province: 'Bulacan', city: '', barangay: '' });
