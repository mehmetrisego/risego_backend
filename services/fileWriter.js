const fs = require('fs');
const path = require('path');

/**
 * Sürücü bilgilerini sürücüler.txt dosyasına yazar
 * @param {Array} driversInfo - Sürücü bilgileri dizisi
 */
function writeDriversToFile(driversInfo) {
    const filePath = path.join(__dirname, '..', 'sürücüler.txt');

    let content = '='.repeat(70) + '\n';
    content += '           YANDEX FLEET - SÜRÜCÜ BİLGİLERİ RAPORU\n';
    content += `           Tarih: ${new Date().toLocaleString('tr-TR')}\n`;
    content += '='.repeat(70) + '\n\n';
    content += `Toplam Sürücü Sayısı: ${driversInfo.length}\n\n`;
    content += '-'.repeat(70) + '\n\n';

    driversInfo.forEach((driver, index) => {
        content += `Sürücü #${index + 1}: ${driver.name}\n`;
        content += '-'.repeat(40) + '\n';

        // Telefon numaraları
        content += `  Telefon Numaraları: `;
        if (driver.phones && driver.phones.length > 0) {
            content += driver.phones.join(', ') + '\n';
        } else {
            content += 'Kayıtlı telefon yok\n';
        }

        // Kayıtlı araçlar
        content += `  Kayıtlı Araç:       ${driver.car}\n`;

        // Yolculuk sayısı
        content += `  Yolculuk Sayısı:    ${driver.tripCount}\n`;

        content += '\n';
    });

    content += '='.repeat(70) + '\n';
    content += '                    RAPOR SONU\n';
    content += '='.repeat(70) + '\n';

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`[FileWriter] Sürücü bilgileri "${filePath}" dosyasına yazıldı.`);
    return filePath;
}

module.exports = { writeDriversToFile };

