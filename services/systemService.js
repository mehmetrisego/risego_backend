let suspendedCities = [];
let _maintenanceWindow = false;

module.exports = {
    getSuspendedCities: () => suspendedCities,
    setSuspendedCities: (cities) => { suspendedCities = cities; },

    isMaintenanceWindowActive: () => _maintenanceWindow,
    setMaintenanceWindow: (active) => {
        _maintenanceWindow = !!active;
        console.log(`[SystemService] Bakım penceresi: ${_maintenanceWindow ? '🔒 AKTİF (00:00–01:00)' : '✅ KAPALI'}`);
    }
};
