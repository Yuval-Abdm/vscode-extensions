CREATE TABLE `clients` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `nom` varchar(100) DEFAULT NULL,
  `solde` decimal(10,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
);
