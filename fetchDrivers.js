/**
 * fetchDrivers.js
 * 
 * Bu script doğrudan çalıştırılabilir:
 *   node fetchDrivers.js
 * 
 * Yandex Fleet API'den sürücü bilgilerini çeker ve sürücüler.txt dosyasına yazar.
 */

const yandexFleetApi = require('./services/yandexFleetApi');
const { writeDriversToFile } = require('./services/fileWriter');

async function main() {
    console.log('='.repeat(50));
    console.log('  Yandex Fleet - Sürücü Bilgileri Çekiliyor...');
    console.log('='.repeat(50));
    console.log('');

    try {
        // Sürücü bilgilerini çek (telefon, araç, yolculuk sayısı dahil)
        const driversInfo = await yandexFleetApi.getAllDriversInfo();

        // Dosyaya yaz
        const filePath = writeDriversToFile(driversInfo);

        console.log('\n' + '='.repeat(50));
        console.log(`  İşlem tamamlandı!`);
        console.log(`  Toplam ${driversInfo.length} sürücü bilgisi çekildi.`);
        console.log(`  Dosya: ${filePath}`);
        console.log('='.repeat(50));

        // Özet göster
        console.log('\n--- ÖZET ---');
        driversInfo.forEach((driver, i) => {
            console.log(`${i + 1}. ${driver.name} | Tel: ${driver.phones.join(', ') || 'Yok'} | Araç: ${driver.car} | Yolculuk: ${driver.tripCount}`);
        });
    } catch (error) {
        console.error('\n[HATA] Sürücü bilgileri çekilemedi:', error.message);
        if (error.response) {
            console.error('API Yanıtı:', JSON.stringify(error.response.data, null, 2));
        }
        process.exit(1);
    }
}

main();

