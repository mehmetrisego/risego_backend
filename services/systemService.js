let suspendedCities = [];

module.exports = {
    getSuspendedCities: () => suspendedCities,
    setSuspendedCities: (cities) => { suspendedCities = cities; }
};
