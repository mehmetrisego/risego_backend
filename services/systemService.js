let _maintenanceWindow = false;

module.exports = {

    isMaintenanceWindowActive: () => _maintenanceWindow,
    setMaintenanceWindow: (active) => {
        _maintenanceWindow = !!active;
        console.log(`[SystemService] Bakım penceresi: ${_maintenanceWindow ? '🔒 AKTİF (06:00–07:00)' : '✅ KAPALI'}`);
    }
};
